use anyhow::{Context, Result, anyhow, bail};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use chrono::Utc;
use clap::{Parser, Subcommand};
use cosaii_protocol::{
    InitializeParams, PROTOCOL_MAX, PROTOCOL_MIN, RpcError, RpcId, RpcRequest, RpcResponse,
};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{RwLock, mpsc, oneshot},
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};

const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PLATFORM: &str = "https://osaii.wyvernhub.net";

#[derive(Parser)]
#[command(
    name = "cosaii-app-server",
    version,
    about = "Persistent local runtime for Cosaii clients"
)]
struct Args {
    #[arg(long)]
    listen: Option<String>,
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long, default_value = DEFAULT_PLATFORM)]
    platform_url: String,
    #[command(subcommand)]
    command: Option<ServerCommand>,
}

#[derive(Subcommand, Clone, Copy)]
enum ServerCommand {
    Proxy,
    GenerateTs,
    GenerateJsonSchema,
}

struct Store {
    db: Mutex<Connection>,
    cipher: XChaCha20Poly1305,
}

#[derive(Clone)]
struct AppState {
    store: Arc<Store>,
    http: Client,
    platform: String,
    data_dir: PathBuf,
    control_dir: PathBuf,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    turns: Arc<RwLock<HashMap<String, tokio::task::AbortHandle>>>,
    clients: Arc<AtomicUsize>,
    last_activity: Arc<AtomicU64>,
    approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

struct ConnectionState {
    id: String,
    initialized: bool,
    client_name: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if let Some(command) = args.command {
        match command {
            ServerCommand::GenerateTs => println!("{}", cosaii_protocol::typescript_bindings()),
            ServerCommand::GenerateJsonSchema => println!(
                "{}",
                serde_json::to_string_pretty(&cosaii_protocol::json_schema())?
            ),
            ServerCommand::Proxy => proxy_stdio(args).await?,
        }
        return Ok(());
    }
    run_daemon(args).await
}

fn home_paths(args: &Args) -> Result<(PathBuf, PathBuf)> {
    let base =
        directories::BaseDirs::new().context("Could not determine the user home directory")?;
    let control = std::env::var_os("COSAII_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.config_dir().join("cosaii"));
    let data = args
        .data_dir
        .clone()
        .or_else(|| std::env::var_os("COSAII_DATA_DIR").map(PathBuf::from))
        .unwrap_or_else(|| base.data_local_dir().join("cosaii"));
    Ok((control, data))
}

async fn run_daemon(args: Args) -> Result<()> {
    let (control_dir, data_dir) = home_paths(&args)?;
    fs::create_dir_all(&control_dir)?;
    fs::create_dir_all(&data_dir)?;
    restrict_dir(&control_dir)?;
    restrict_dir(&data_dir)?;
    #[cfg(unix)]
    let endpoint = args.listen.clone().unwrap_or_else(|| {
        control_dir
            .join("app-server.sock")
            .to_string_lossy()
            .into_owned()
    });
    #[cfg(windows)]
    let endpoint = args.listen.clone().unwrap_or_else(default_windows_pipe);
    let pid_path = control_dir.join("app-server.pid");
    #[cfg(unix)]
    {
        let socket_path = PathBuf::from(&endpoint);
        if socket_path.exists() {
            match UnixStream::connect(&socket_path).await {
                Ok(_) => bail!(
                    "A Cosaii app-server is already listening at {}",
                    socket_path.display()
                ),
                Err(_) if recorded_process_alive(&pid_path) => {
                    bail!("The recorded app-server process is alive but its socket is unavailable")
                }
                Err(_) => {
                    fs::remove_file(&socket_path).context("remove stale app-server socket")?
                }
            }
        }
    }
    #[cfg(windows)]
    if ClientOptions::new().open(&endpoint).is_ok() {
        bail!("A Cosaii app-server is already listening at {endpoint}")
    } else if recorded_process_alive(&pid_path) {
        bail!("The recorded app-server process is alive but its named pipe is unavailable")
    }
    let store = Arc::new(open_store(&data_dir)?);
    recover_interrupted_turns(&store)?;
    fs::write(&pid_path, std::process::id().to_string())?;
    let state = AppState {
        store,
        http: Client::builder()
            .user_agent(format!("cosaii-app-server/{SERVER_VERSION}"))
            .build()?,
        platform: args.platform_url.trim_end_matches('/').to_owned(),
        data_dir,
        control_dir,
        subscriptions: Arc::new(RwLock::new(HashMap::new())),
        turns: Arc::new(RwLock::new(HashMap::new())),
        clients: Arc::new(AtomicUsize::new(0)),
        last_activity: Arc::new(AtomicU64::new(epoch_seconds())),
        approvals: Arc::new(Mutex::new(HashMap::new())),
    };
    if std::env::var_os("COSAII_SERVICE").is_none() {
        let idle_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let idle_for = epoch_seconds()
                    .saturating_sub(idle_state.last_activity.load(Ordering::Relaxed));
                if idle_for >= 1_800
                    && idle_state.clients.load(Ordering::Relaxed) == 0
                    && idle_state.turns.read().await.is_empty()
                {
                    std::process::exit(0);
                }
            }
        });
    }
    #[cfg(unix)]
    let result = {
        let socket_path = PathBuf::from(&endpoint);
        let listener = UnixListener::bind(&socket_path)?;
        restrict_file(&socket_path)?;
        let result = loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Err(error) = serve_socket(stream, state).await {
                            eprintln!("connection error: {error:#}");
                        }
                    });
                }
                Err(error) => break Err(error.into()),
            }
        };
        let _ = fs::remove_file(&socket_path);
        result
    };
    #[cfg(windows)]
    let result = {
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&endpoint)?;
        loop {
            if let Err(error) = server.connect().await {
                break Err(error.into());
            }
            let next = ServerOptions::new().create(&endpoint)?;
            let connected = server;
            let state = state.clone();
            tokio::spawn(async move {
                if let Err(error) = serve_socket(connected, state).await {
                    eprintln!("connection error: {error:#}")
                }
            });
            server = next;
        }
    };
    let _ = fs::remove_file(&pid_path);
    result
}

async fn serve_socket<S>(stream: S, state: AppState) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let ws = accept_async(stream).await?;
    state.clients.fetch_add(1, Ordering::Relaxed);
    state
        .last_activity
        .store(epoch_seconds(), Ordering::Relaxed);
    let result = serve_rpc(ws, state.clone()).await;
    state.clients.fetch_sub(1, Ordering::Relaxed);
    state
        .last_activity
        .store(epoch_seconds(), Ordering::Relaxed);
    result
}

async fn serve_rpc<S>(mut ws: WebSocketStream<S>, state: AppState) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let connection_id = Uuid::new_v4().to_string();
    let mut connection = ConnectionState {
        id: connection_id.clone(),
        initialized: false,
        client_name: String::new(),
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(value) => ws.send(Message::Text(value.to_string().into())).await?,
                None => break,
            },
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = match serde_json::from_str(&text) { Ok(value) => value, Err(error) => { tx.send(error_response(RpcId::Number(0), -32700, "Parse error", Some(json!({"detail": error.to_string()}))))?; continue; } };
                    if value.get("id").is_some() && value.get("method").is_none() {
                        let key = rpc_id_key(&value["id"]);
                        if let Some(waiter) = state.approvals.lock().unwrap().remove(&key) {
                            let approved = value["result"]["approved"].as_bool().unwrap_or(false);
                            let _ = waiter.send(approved);
                        }
                    } else if value.get("id").is_some() {
                        let request: RpcRequest = match serde_json::from_value(value) { Ok(request) => request, Err(error) => { tx.send(error_response(RpcId::Number(0), -32600, "Invalid request", Some(json!({"detail": error.to_string()}))))?; continue; } };
                        let response = dispatch(&mut connection, request, state.clone(), tx.clone()).await;
                        tx.send(response)?;
                    } else if value.get("method").and_then(Value::as_str) == Some("initialized") {
                        if connection.initialized { tx.send(notification("server/ready", json!({"connection_id": connection.id})))?; }
                    }
                }
                Some(Ok(Message::Ping(bytes))) => ws.send(Message::Pong(bytes)).await?,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(error)) => return Err(error.into()),
                _ => {}
            }
        }
    }
    state.subscriptions.write().await.remove(&connection_id);
    Ok(())
}

async fn dispatch(
    connection: &mut ConnectionState,
    request: RpcRequest,
    state: AppState,
    tx: mpsc::UnboundedSender<Value>,
) -> Value {
    state
        .last_activity
        .store(epoch_seconds(), Ordering::Relaxed);
    let id = request.id.clone();
    if !connection.initialized && request.method != "initialize" {
        return error_response(id, -32010, "initialize must be the first request", None);
    }
    let result = match request.method.as_str() {
        "initialize" => initialize(connection, request.params, &state),
        "server/status" => Ok(
            json!({"version":SERVER_VERSION,"protocol":{"min":PROTOCOL_MIN,"max":PROTOCOL_MAX},"pid":std::process::id(),"data_dir":state.data_dir,"clients":state.clients.load(Ordering::Relaxed)}),
        ),
        "server/shutdown" => {
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                std::process::exit(0);
            });
            Ok(json!({"shutting_down":true}))
        }
        "account/read" => account_read(&state),
        "account/login/start" => account_login_start(&state, request.params, tx).await,
        "account/logout" => account_logout(&state),
        "thread/start" => thread_start(&state, request.params),
        "thread/list" => thread_list(&state, request.params),
        "thread/read" | "thread/resume" => thread_read(&state, request.params),
        "thread/fork" => thread_fork(&state, request.params),
        "thread/archive" => thread_mark(&state, request.params, "archived", 1),
        "thread/unarchive" => thread_mark(&state, request.params, "archived", 0),
        "thread/delete" => thread_delete(&state, request.params),
        "thread/pin" => thread_mark(&state, request.params, "pinned", 1),
        "thread/unpin" => thread_mark(&state, request.params, "pinned", 0),
        "thread/name/set" => thread_name(&state, request.params),
        "thread/settings/set" => thread_settings(&state, request.params),
        "thread/export" => thread_export(&state, request.params),
        "thread/import" => thread_import(&state, request.params),
        "thread/subscribe" => thread_subscribe(connection, &state, request.params).await,
        "turn/start" => turn_start(&state, request.params, tx).await,
        "turn/interrupt" => turn_interrupt(&state, request.params).await,
        "model/list" => platform_get(&state, "/cosaii/api/v1/models").await,
        "permissionProfile/list" => Ok(permission_profiles()),
        "permissionProfile/set" => permission_set(&state, request.params),
        "config/read" => config_read(&state, request.params),
        "config/write" => config_write(&state, request.params),
        "config/batchWrite" => config_batch_write(&state, request.params),
        "skills/list" | "skills/reload" => skills_list(&state, request.params),
        "mcpServer/list" | "mcpServer/reload" => mcp_list(&state, request.params),
        "remoteControl/enable" => remote_enable(&state, request.params).await,
        "remoteControl/disable" => remote_disable(&state).await,
        "remoteControl/status" => remote_status(&state),
        "remoteControl/pairing/start" => remote_pair(&state).await,
        "remoteControl/client/list" => remote_clients(&state).await,
        "fs/read" => fs_read(request.params),
        "fs/list" => fs_list(request.params),
        "fs/metadata" => fs_metadata(request.params),
        "fs/write" => fs_write(request.params),
        "command/exec" => command_exec(request.params, tx).await,
        method if method.starts_with("platform/") => {
            platform_get(&state, &format!("/cosaii/api/v1/platform/{}", &method[9..])).await
        }
        _ => Err(RpcFailure::new(
            -32601,
            format!("Method not found: {}", request.method),
        )),
    };
    match result {
        Ok(value) => success_response(id, value),
        Err(error) => error_response(id, error.code, &error.message, error.data),
    }
}

#[derive(Debug)]
struct RpcFailure {
    code: i32,
    message: String,
    data: Option<Value>,
}
impl RpcFailure {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    fn data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}
impl From<anyhow::Error> for RpcFailure {
    fn from(value: anyhow::Error) -> Self {
        Self::new(-32603, value.to_string())
    }
}

fn initialize(
    connection: &mut ConnectionState,
    params: Value,
    state: &AppState,
) -> std::result::Result<Value, RpcFailure> {
    if connection.initialized {
        return Err(RpcFailure::new(-32011, "Connection is already initialized"));
    }
    let init: InitializeParams =
        serde_json::from_value(params).map_err(|e| RpcFailure::new(-32602, e.to_string()))?;
    if init.protocol_version < PROTOCOL_MIN || init.protocol_version > PROTOCOL_MAX {
        return Err(RpcFailure::new(-32012, "No compatible protocol version")
            .data(json!({"supported":{"min":PROTOCOL_MIN,"max":PROTOCOL_MAX}})));
    }
    connection.initialized = true;
    connection.client_name = init.client_name;
    Ok(
        json!({"protocol_version":init.protocol_version,"server":{"name":"cosaii-app-server","version":SERVER_VERSION},"capabilities":{"threads":true,"streaming":true,"tool_argument_deltas":true,"reverse_requests":true,"encrypted_persistence":true,"remote_control":true},"platform":std::env::consts::OS,"data_dir":state.data_dir}),
    )
}

fn open_store(data_dir: &Path) -> Result<Store> {
    let key = load_store_key(data_dir)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let db = Connection::open(data_dir.join("sessions.db"))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL,model TEXT NOT NULL DEFAULT 'auto',reasoning TEXT NOT NULL DEFAULT 'medium',permission_profile TEXT NOT NULL DEFAULT 'always_ask',status TEXT NOT NULL DEFAULT 'idle',pinned INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,parent_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,status TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,content BLOB NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config(scope TEXT NOT NULL,key TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS credentials(name TEXT PRIMARY KEY,value BLOB NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,detail BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(archived,pinned DESC,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_turn ON items(turn_id,ordinal);")?;
    Ok(Store {
        db: Mutex::new(db),
        cipher,
    })
}

fn load_store_key(data_dir: &Path) -> Result<[u8; 32]> {
    let key_id = hex::encode(Sha256::digest(data_dir.to_string_lossy().as_bytes()));
    let entry = keyring::Entry::new("cosaii-app-server", &key_id)?;
    if let Ok(existing) = entry.get_password() {
        let bytes = STANDARD.decode(existing)?;
        return bytes
            .try_into()
            .map_err(|_| anyhow!("Invalid credential-store key length"));
    }
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    if entry.set_password(&STANDARD.encode(key)).is_ok() {
        return Ok(key);
    }
    let passphrase = std::env::var("COSAII_STORE_PASSPHRASE").context("No OS credential store is available. Set COSAII_STORE_PASSPHRASE for the encrypted fallback store.")?;
    let salt_path = data_dir.join("store.salt");
    let salt = if salt_path.exists() {
        fs::read(&salt_path)?
    } else {
        let mut value = vec![0u8; 32];
        rand::rng().fill_bytes(&mut value);
        fs::write(&salt_path, &value)?;
        restrict_file(&salt_path)?;
        value
    };
    let mut hasher = Sha256::new();
    hasher.update(passphrase.as_bytes());
    hasher.update(salt);
    Ok(hasher.finalize().into())
}

impl Store {
    fn encrypt(&self, value: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; 24];
        rand::rng().fill_bytes(&mut nonce);
        let mut out = nonce.to_vec();
        out.extend(
            self.cipher
                .encrypt(XNonce::from_slice(&nonce), value)
                .map_err(|_| anyhow!("encryption failed"))?,
        );
        Ok(out)
    }
    fn decrypt(&self, value: &[u8]) -> Result<Vec<u8>> {
        if value.len() < 25 {
            bail!("invalid ciphertext")
        }
        self.cipher
            .decrypt(XNonce::from_slice(&value[..24]), &value[24..])
            .map_err(|_| anyhow!("could not decrypt local data"))
    }
    fn put_secret(&self, name: &str, value: &str) -> Result<()> {
        let encrypted = self.encrypt(value.as_bytes())?;
        self.db.lock().unwrap().execute("INSERT INTO credentials(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![name,encrypted,now()])?;
        Ok(())
    }
    fn get_secret(&self, name: &str) -> Result<Option<String>> {
        let bytes: Option<Vec<u8>> = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT value FROM credentials WHERE name=?", [name], |r| {
                r.get(0)
            })
            .optional()?;
        bytes
            .map(|v| String::from_utf8(self.decrypt(&v)?).map_err(Into::into))
            .transpose()
    }
}

fn recover_interrupted_turns(store: &Store) -> Result<()> {
    let db = store.db.lock().unwrap();
    db.execute(
        "UPDATE turns SET status='interrupted',completed_at=? WHERE status='running'",
        [now()],
    )?;
    db.execute(
        "UPDATE threads SET status='interrupted' WHERE status='running'",
        [],
    )?;
    Ok(())
}

fn account_read(state: &AppState) -> std::result::Result<Value, RpcFailure> {
    Ok(match state.store.get_secret("account")? {
        Some(v) => serde_json::from_str(&v).unwrap_or(json!({"signed_in":false})),
        None => json!({"signed_in":false}),
    })
}
fn account_logout(state: &AppState) -> std::result::Result<Value, RpcFailure> {
    let db = state.store.db.lock().unwrap();
    db.execute(
        "DELETE FROM credentials WHERE name IN ('account','access_token','refresh_token')",
        [],
    )
    .map_err(anyhow::Error::from)?;
    Ok(json!({"signed_in":false}))
}

async fn account_login_start(
    state: &AppState,
    params: Value,
    tx: mpsc::UnboundedSender<Value>,
) -> std::result::Result<Value, RpcFailure> {
    let scopes = params.get("scopes").cloned().unwrap_or(json!([
        "inference",
        "models:read",
        "usage:read",
        "projects:read",
        "projects:write",
        "memory:read",
        "memory:write",
        "tasks:read",
        "tasks:write",
        "plugins:read",
        "plugins:write",
        "agents:read",
        "agents:write",
        "notifications:read",
        "remote:control"
    ]));
    let response=state.http.post(format!("{}/platform/api/cli/device/start",state.platform)).json(&json!({"client_name":"Cosaii CLI","device_name":hostname(),"platform":std::env::consts::OS,"scopes":scopes})).send().await.map_err(anyhow::Error::from)?;
    let status = response.status();
    let grant: Value = response.json().await.map_err(anyhow::Error::from)?;
    if !status.is_success() {
        return Err(RpcFailure::new(-32020, "Platform login could not start").data(grant));
    }
    let device_code = grant["device_code"].as_str().unwrap_or_default().to_owned();
    let interval = grant["interval"].as_u64().unwrap_or(2);
    let state2 = state.clone();
    let tx2 = tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            let r=state2.http.post(format!("{}/platform/api/cli/device/token",state2.platform)).json(&json!({"device_code":device_code,"device_name":hostname(),"platform":std::env::consts::OS})).send().await;
            let Ok(r) = r else { continue };
            let status = r.status();
            let Ok(body) = r.json::<Value>().await else {
                continue;
            };
            if status.as_u16() == 428 {
                continue;
            }
            if status.is_success() {
                let _ = state2.store.put_secret(
                    "access_token",
                    body["access_token"].as_str().unwrap_or_default(),
                );
                let _ = state2.store.put_secret(
                    "refresh_token",
                    body["refresh_token"].as_str().unwrap_or_default(),
                );
                if let Ok(account) = platform_get(&state2, "/cosaii/api/v1/bootstrap").await {
                    let _ = state2
                        .store
                        .put_secret("account", &account["account"].to_string());
                    let _ = tx2.send(notification(
                        "account/login/completed",
                        json!({"account":account["account"]}),
                    ));
                }
                break;
            }
            let _ = tx2.send(notification("account/login/failed", body));
            break;
        }
    });
    Ok(grant)
}

fn thread_start(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let id = Uuid::new_v4().to_string();
    let workspace = canonical_workspace(p.get("workspace").and_then(Value::as_str).unwrap_or("."))?;
    let title = p
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("New session");
    let model = p.get("model").and_then(Value::as_str).unwrap_or("auto");
    let reasoning = p
        .get("reasoning")
        .and_then(Value::as_str)
        .unwrap_or("medium");
    let permission = p
        .get("permission_profile")
        .and_then(Value::as_str)
        .unwrap_or("always_ask");
    let ts = now();
    state.store.db.lock().unwrap().execute("INSERT INTO threads(id,title,workspace,model,reasoning,permission_profile,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'idle',?,?)",params![id,title,workspace,model,reasoning,permission,ts,ts]).map_err(anyhow::Error::from)?;
    thread_read(state, json!({"thread_id":id}))
}

fn thread_list(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let archived = p.get("archived").and_then(Value::as_bool).unwrap_or(false) as i32;
    let query = p.get("query").and_then(Value::as_str).unwrap_or("");
    let db = state.store.db.lock().unwrap();
    let mut stmt=db.prepare("SELECT id,title,workspace,model,reasoning,permission_profile,status,pinned,archived,created_at,updated_at FROM threads WHERE archived=? ORDER BY pinned DESC,updated_at DESC LIMIT 500").map_err(anyhow::Error::from)?;
    let mut rows = stmt
        .query_map([archived], thread_row)
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    if !query.is_empty() {
        let needle = query.to_lowercase();
        rows.retain(|thread| {
            if thread["title"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&needle)
            {
                return true;
            }
            let id = thread["id"].as_str().unwrap_or("");
            let mut item_stmt = match db.prepare(
                "SELECT i.content FROM items i JOIN turns t ON t.id=i.turn_id WHERE t.thread_id=?",
            ) {
                Ok(value) => value,
                Err(_) => return false,
            };
            let values = match item_stmt.query_map([id], |row| row.get::<_, Vec<u8>>(0)) {
                Ok(value) => value,
                Err(_) => return false,
            };
            values.filter_map(Result::ok).any(|value| {
                state
                    .store
                    .decrypt(&value)
                    .ok()
                    .and_then(|value| String::from_utf8(value).ok())
                    .is_some_and(|text| text.to_lowercase().contains(&needle))
            })
        });
    }
    rows.truncate(200);
    Ok(json!({"threads":rows}))
}
fn thread_read(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let id = required_str(&p, "thread_id")?;
    let db = state.store.db.lock().unwrap();
    let thread=db.query_row("SELECT id,title,workspace,model,reasoning,permission_profile,status,pinned,archived,created_at,updated_at FROM threads WHERE id=?",[id],thread_row).optional().map_err(anyhow::Error::from)?.ok_or_else(||RpcFailure::new(-32004,"Thread not found"))?;
    let mut stmt=db.prepare("SELECT i.id,i.turn_id,i.kind,i.status,i.created_at,i.content FROM items i JOIN turns t ON t.id=i.turn_id WHERE t.thread_id=? ORDER BY t.started_at,i.ordinal").map_err(anyhow::Error::from)?;
    let items=stmt.query_map([id],|r|{let encrypted:Vec<u8>=r.get(5)?;Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,encrypted))}).map_err(anyhow::Error::from)?.filter_map(|row|row.ok()).map(|(iid,tid,kind,status,created,encrypted)|json!({"id":iid,"turn_id":tid,"kind":kind,"status":status,"created_at":created,"content":serde_json::from_slice::<Value>(&state.store.decrypt(&encrypted).unwrap_or_default()).unwrap_or(Value::Null)})).collect::<Vec<_>>();
    Ok(json!({"thread":thread,"items":items}))
}
fn thread_fork(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let source = thread_read(state, p.clone())?;
    let mut create = json!({"workspace":source["thread"]["workspace"],"title":format!("{} (fork)",source["thread"]["title"].as_str().unwrap_or("Session")),"model":source["thread"]["model"],"reasoning":source["thread"]["reasoning"],"permission_profile":source["thread"]["permission_profile"]});
    if let Some(title) = p.get("title") {
        create["title"] = title.clone()
    }
    let fork = thread_start(state, create)?;
    state
        .store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE threads SET parent_id=? WHERE id=?",
            params![
                required_str(&p, "thread_id")?,
                fork["thread"]["id"].as_str()
            ],
        )
        .map_err(anyhow::Error::from)?;
    Ok(fork)
}
fn thread_mark(
    state: &AppState,
    p: Value,
    column: &str,
    value: i32,
) -> std::result::Result<Value, RpcFailure> {
    let id = required_str(&p, "thread_id")?;
    state
        .store
        .db
        .lock()
        .unwrap()
        .execute(
            &format!("UPDATE threads SET {column}=?,updated_at=? WHERE id=?"),
            params![value, now(), id],
        )
        .map_err(anyhow::Error::from)?;
    Ok(json!({"ok":true}))
}
fn thread_delete(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let id = required_str(&p, "thread_id")?;
    state
        .store
        .db
        .lock()
        .unwrap()
        .execute("DELETE FROM threads WHERE id=?", [id])
        .map_err(anyhow::Error::from)?;
    Ok(json!({"deleted":true}))
}
fn thread_export(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let data = thread_read(state, p.clone())?;
    let format = p.get("format").and_then(Value::as_str).unwrap_or("json");
    let title = data["thread"]["title"].as_str().unwrap_or("Cosaii session");
    let markdown = || {
        let mut out = format!("# {title}\n\n");
        for item in data["items"].as_array().into_iter().flatten() {
            let kind = item["kind"].as_str().unwrap_or("item");
            let text = item["content"]["text"].as_str().unwrap_or("");
            if !text.is_empty() {
                out.push_str(&format!(
                    "## {}\n\n{}\n\n",
                    if kind == "user_message" {
                        "User"
                    } else {
                        "Cosaii"
                    },
                    text
                ));
            }
        }
        out
    };
    let bytes = match format {
        "json" => serde_json::to_vec_pretty(&data).map_err(anyhow::Error::from)?,
        "markdown" | "md" => markdown().into_bytes(),
        "zip" => {
            let cursor = Cursor::new(Vec::new());
            let mut archive = zip::ZipWriter::new(cursor);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            archive
                .start_file("session.json", options)
                .map_err(anyhow::Error::from)?;
            archive
                .write_all(&serde_json::to_vec_pretty(&data).map_err(anyhow::Error::from)?)
                .map_err(anyhow::Error::from)?;
            archive
                .start_file("session.md", options)
                .map_err(anyhow::Error::from)?;
            archive
                .write_all(markdown().as_bytes())
                .map_err(anyhow::Error::from)?;
            archive.finish().map_err(anyhow::Error::from)?.into_inner()
        }
        _ => {
            return Err(RpcFailure::new(
                -32602,
                "format must be json, markdown, or zip",
            ));
        }
    };
    if let Some(path) = p.get("path").and_then(Value::as_str) {
        fs::write(path, &bytes).map_err(anyhow::Error::from)?;
        Ok(json!({"path":path,"format":format,"bytes":bytes.len()}))
    } else {
        Ok(json!({"format":format,"base64":STANDARD.encode(bytes)}))
    }
}
fn thread_import(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let bytes = if let Some(path) = p.get("path").and_then(Value::as_str) {
        fs::read(path).map_err(anyhow::Error::from)?
    } else {
        STANDARD
            .decode(required_str(&p, "base64")?)
            .map_err(anyhow::Error::from)?
    };
    let data: Value = if bytes.starts_with(b"PK") {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(anyhow::Error::from)?;
        let mut file = zip.by_name("session.json").map_err(anyhow::Error::from)?;
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut raw).map_err(anyhow::Error::from)?;
        serde_json::from_slice(&raw).map_err(anyhow::Error::from)?
    } else {
        serde_json::from_slice(&bytes).map_err(anyhow::Error::from)?
    };
    let source = &data["thread"];
    let created = thread_start(
        state,
        json!({"workspace":p.get("workspace").and_then(Value::as_str).or_else(||source["workspace"].as_str()).unwrap_or("."),"title":source["title"].as_str().unwrap_or("Imported session"),"model":source["model"].as_str().unwrap_or("auto"),"reasoning":source["reasoning"].as_str().unwrap_or("medium"),"permission_profile":"always_ask"}),
    )?;
    let thread_id = created["thread"]["id"].as_str().unwrap_or_default();
    let turn_id = Uuid::new_v4().to_string();
    let db = state.store.db.lock().unwrap();
    db.execute("INSERT INTO turns(id,thread_id,status,started_at,completed_at) VALUES(?,?,'completed',?,?)",params![turn_id,thread_id,now(),now()]).map_err(anyhow::Error::from)?;
    for (index, item) in data["items"].as_array().into_iter().flatten().enumerate() {
        insert_item(
            &state.store,
            &db,
            &Uuid::new_v4().to_string(),
            &turn_id,
            index as i64,
            item["kind"].as_str().unwrap_or("agent_message"),
            &item["content"],
            "completed",
        )?
    }
    drop(db);
    thread_read(state, json!({"thread_id":thread_id}))
}
fn thread_name(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let id = required_str(&p, "thread_id")?;
    let title = required_str(&p, "title")?;
    state
        .store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE threads SET title=?,updated_at=? WHERE id=?",
            params![title, now(), id],
        )
        .map_err(anyhow::Error::from)?;
    Ok(json!({"thread_id":id,"title":title}))
}
fn thread_settings(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let id = required_str(&p, "thread_id")?;
    let model = p.get("model").and_then(Value::as_str);
    let reasoning = p.get("reasoning").and_then(Value::as_str);
    let permission = p.get("permission_profile").and_then(Value::as_str);
    if let Some(value) = reasoning.filter(|v| !["none", "light", "medium", "max"].contains(v)) {
        return Err(RpcFailure::new(
            -32602,
            format!("Invalid reasoning level: {value}"),
        ));
    }
    if let Some(value) = permission
        .filter(|v| !["deny_all", "allow_low_risk", "always_ask", "full_access"].contains(v))
    {
        return Err(RpcFailure::new(
            -32602,
            format!("Invalid permission profile: {value}"),
        ));
    }
    let db = state.store.db.lock().unwrap();
    if let Some(value) = model {
        db.execute(
            "UPDATE threads SET model=?,updated_at=? WHERE id=?",
            params![value, now(), id],
        )
        .map_err(anyhow::Error::from)?;
    }
    if let Some(value) = reasoning {
        db.execute(
            "UPDATE threads SET reasoning=?,updated_at=? WHERE id=?",
            params![value, now(), id],
        )
        .map_err(anyhow::Error::from)?;
    }
    if let Some(value) = permission {
        db.execute(
            "UPDATE threads SET permission_profile=?,updated_at=? WHERE id=?",
            params![value, now(), id],
        )
        .map_err(anyhow::Error::from)?;
    }
    drop(db);
    thread_read(state, json!({"thread_id":id}))
}
async fn thread_subscribe(
    connection: &ConnectionState,
    state: &AppState,
    p: Value,
) -> std::result::Result<Value, RpcFailure> {
    let ids = p
        .get("thread_ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    state
        .subscriptions
        .write()
        .await
        .insert(connection.id.clone(), ids);
    Ok(json!({"subscribed":true}))
}

async fn turn_start(
    state: &AppState,
    p: Value,
    tx: mpsc::UnboundedSender<Value>,
) -> std::result::Result<Value, RpcFailure> {
    let thread_id = required_str(&p, "thread_id")?.to_owned();
    let input = required_str(&p, "input")?.to_owned();
    let interactive = p
        .get("interactive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let thread = thread_read(state, json!({"thread_id":thread_id}))?;
    let turn_id = Uuid::new_v4().to_string();
    let user_item = Uuid::new_v4().to_string();
    let agent_item = Uuid::new_v4().to_string();
    let started = now();
    {
        let db = state.store.db.lock().unwrap();
        db.execute(
            "INSERT INTO turns(id,thread_id,status,started_at) VALUES(?,?,'running',?)",
            params![turn_id, thread_id, started],
        )
        .map_err(anyhow::Error::from)?;
        insert_item(
            &state.store,
            &db,
            &user_item,
            &turn_id,
            0,
            "user_message",
            &json!({"text":input}),
            "completed",
        )?;
        insert_item(
            &state.store,
            &db,
            &agent_item,
            &turn_id,
            1,
            "agent_message",
            &json!({"text":""}),
            "running",
        )?;
        db.execute(
            "UPDATE threads SET status='running',updated_at=? WHERE id=?",
            params![started, thread_id],
        )
        .map_err(anyhow::Error::from)?;
    }
    tx.send(notification(
        "turn/started",
        json!({"thread_id":thread_id,"turn_id":turn_id}),
    ))
    .ok();
    tx.send(notification("item/started",json!({"thread_id":thread_id,"turn_id":turn_id,"item":{"id":agent_item,"kind":"agent_message"}}))).ok();
    let state2 = state.clone();
    let tid = turn_id.clone();
    let thid = thread_id.clone();
    let iid = agent_item.clone();
    let task = tokio::spawn(async move {
        let result =
            run_inference(&state2, thread, input, interactive, &tid, &thid, &iid, &tx).await;
        finish_turn(&state2, &tid, &thid, &iid, result, &tx);
        state2.turns.write().await.remove(&tid);
    });
    state
        .turns
        .write()
        .await
        .insert(turn_id.clone(), task.abort_handle());
    Ok(json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":agent_item}))
}

async fn run_inference(
    state: &AppState,
    thread: Value,
    input: String,
    interactive: bool,
    turn_id: &str,
    thread_id: &str,
    item_id: &str,
    tx: &mpsc::UnboundedSender<Value>,
) -> Result<String> {
    let access = ensure_access_token(state)
        .await
        .map_err(|error| anyhow!(error.message))?;
    let mut messages = Vec::new();
    for item in thread["items"].as_array().into_iter().flatten() {
        let kind = item["kind"].as_str().unwrap_or("");
        let text = item["content"]["text"].as_str().unwrap_or("");
        if !text.is_empty() && (kind == "user_message" || kind == "agent_message") {
            messages.push(
                json!({"role":if kind=="user_message"{"user"}else{"assistant"},"content":text}),
            );
        }
    }
    messages.push(json!({"role":"user","content":input}));
    let workspace = PathBuf::from(thread["thread"]["workspace"].as_str().unwrap_or("."));
    let permission = thread["thread"]["permission_profile"]
        .as_str()
        .unwrap_or("always_ask");
    let mut visible_output = String::new();
    for step in 0..32 {
        let response = state.http.post(format!("{}/cosaii/api/v1/chat",state.platform)).bearer_auth(&access).json(&json!({
            "model":thread["thread"]["model"], "reasoning":thread["thread"]["reasoning"], "messages":messages,
            "stream":true, "parallel_tool_calls":true, "tools":agent_tools(),
            "agent_turn_id":turn_id, "continuation_index":step
        })).send().await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!("Platform inference returned {status}: {body}")
        }
        let mut stream = response.bytes_stream();
        let mut pending = String::new();
        let mut step_text = String::new();
        let mut tool_calls: HashMap<usize, Value> = HashMap::new();
        while let Some(chunk) = stream.next().await {
            pending.push_str(&String::from_utf8_lossy(&chunk?));
            while let Some(pos) = pending.find('\n') {
                let line = pending.drain(..=pos).collect::<String>();
                let data = line.trim().strip_prefix("data: ").unwrap_or("");
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                let delta = &event["choices"][0]["delta"];
                let text = delta["content"]
                    .as_str()
                    .or_else(|| event["delta"].as_str())
                    .unwrap_or("");
                if !text.is_empty() {
                    step_text.push_str(text);
                    visible_output.push_str(text);
                    tx.send(notification("item/agentMessage/delta",json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":item_id,"delta":text}))).ok();
                }
                let reasoning = delta["reasoning_content"].as_str().unwrap_or("");
                if !reasoning.is_empty() {
                    tx.send(notification("item/reasoning/delta",json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":item_id,"delta":reasoning}))).ok();
                }
                for call in delta["tool_calls"].as_array().into_iter().flatten() {
                    let index = call["index"].as_u64().unwrap_or(0) as usize;
                    let entry = tool_calls.entry(index).or_insert_with(
                        || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                    );
                    if let Some(id) = call["id"].as_str() {
                        entry["id"] = json!(id)
                    }
                    if let Some(name) = call["function"]["name"].as_str() {
                        entry["function"]["name"] = json!(name)
                    }
                    if let Some(args) = call["function"]["arguments"].as_str() {
                        let current = entry["function"]["arguments"].as_str().unwrap_or("");
                        entry["function"]["arguments"] = json!(format!("{current}{args}"));
                        tx.send(notification("item/toolCall/argumentsDelta",json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":entry["id"],"name":entry["function"]["name"],"delta":args}))).ok();
                    }
                }
            }
        }
        if tool_calls.is_empty() {
            return Ok(visible_output);
        }
        let mut ordered = tool_calls.into_iter().collect::<Vec<_>>();
        ordered.sort_by_key(|(index, _)| *index);
        let calls = ordered
            .into_iter()
            .map(|(_, call)| call)
            .collect::<Vec<_>>();
        messages.push(json!({"role":"assistant","content":if step_text.is_empty(){Value::Null}else{json!(step_text)},"tool_calls":calls}));
        for call in calls {
            let id = call["id"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let name = call["function"]["name"].as_str().unwrap_or("");
            let raw = call["function"]["arguments"].as_str().unwrap_or("{}");
            let args = serde_json::from_str::<Value>(raw)
                .unwrap_or_else(|_| json!({"_malformed_arguments":raw}));
            tx.send(notification("item/started",json!({"thread_id":thread_id,"turn_id":turn_id,"item":{"id":id,"kind":"tool_call","name":name,"arguments":args}}))).ok();
            let result =
                execute_agent_tool(state, name, args, &workspace, permission, interactive, tx)
                    .await;
            let failed = result.get("error").is_some();
            tx.send(notification("item/completed",json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":id,"kind":"tool_call","status":if failed{"failed"}else{"completed"},"output":result}))).ok();
            messages.push(json!({"role":"tool","tool_call_id":id,"content":result.to_string()}));
        }
    }
    bail!("Agent reached the 32-step safety bound")
}

fn agent_tools() -> Value {
    json!([
      {"type":"function","function":{"name":"fs_read","description":"Read a file in the workspace.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
      {"type":"function","function":{"name":"fs_list","description":"List a directory, including empty directories.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}},
      {"type":"function","function":{"name":"fs_write","description":"Write complete text to a workspace file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"text":{"type":"string"}},"required":["path","text"]}}},
      {"type":"function","function":{"name":"fs_patch","description":"Replace one exact text occurrence in a workspace file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"before":{"type":"string"},"after":{"type":"string"}},"required":["path","before","after"]}}},
      {"type":"function","function":{"name":"shell_exec","description":"Run a shell command in the workspace. Use for Git, tests, builds, formatters, and project commands.","parameters":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"}},"required":["command"]}}},
      {"type":"function","function":{"name":"web_fetch","description":"Fetch a public HTTP or HTTPS URL as text.","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}}
    ])
}

async fn execute_agent_tool(
    state: &AppState,
    name: &str,
    args: Value,
    workspace: &Path,
    permission: &str,
    interactive: bool,
    tx: &mpsc::UnboundedSender<Value>,
) -> Value {
    let is_read = matches!(name, "fs_read" | "fs_list" | "web_fetch");
    let dangerous = name == "shell_exec" && looks_dangerous(args["command"].as_str().unwrap_or(""));
    let must_ask = match permission {
        "always_ask" => true,
        "allow_low_risk" => !is_read,
        "full_access" => dangerous,
        _ => false,
    };
    let allowed = if permission == "deny_all" {
        false
    } else if must_ask {
        request_tool_approval(state, name, &args, workspace, interactive, tx).await
    } else {
        true
    };
    if !allowed {
        return json!({"error":"permission_denied","message":if dangerous{"This sensitive action requires explicit approval."}else{"The effective permission profile did not allow this action."},"tool":name,"retryable":true});
    }
    let resolve_path = |value: &Value| -> Result<PathBuf> {
        let raw = value.as_str().unwrap_or("");
        let candidate = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            workspace.join(raw)
        };
        let parent = candidate.parent().unwrap_or(workspace);
        let canonical_parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        if !canonical_parent.starts_with(workspace) {
            bail!("Path is outside the trusted workspace")
        };
        Ok(candidate)
    };
    let result:Result<Value>=async{match name{
      "fs_read"=>{let path=resolve_path(&args["path"])?;let bytes=fs::read(&path)?;if bytes.len()>8*1024*1024{bail!("File exceeds 8 MiB")};Ok(json!({"path":path,"text":redact_credentials(&String::from_utf8_lossy(&bytes)),"bytes":bytes.len()}))},
      "fs_list"=>{let path=resolve_path(args.get("path").unwrap_or(&json!(".")))?;let mut entries=Vec::new();for entry in fs::read_dir(&path)?{let entry=entry?;entries.push(json!({"name":entry.file_name(),"directory":entry.file_type()?.is_dir()}));}Ok(json!({"path":path,"entries":entries}))},
      "fs_write"=>{let path=resolve_path(&args["path"])?;if let Some(parent)=path.parent(){fs::create_dir_all(parent)?}let text=args["text"].as_str().context("text is required")?;fs::write(&path,text)?;Ok(json!({"path":path,"bytes":text.len(),"written":true}))},
      "fs_patch"=>{let path=resolve_path(&args["path"])?;let before=args["before"].as_str().context("before is required")?;let after=args["after"].as_str().context("after is required")?;let current=fs::read_to_string(&path)?;let count=current.matches(before).count();if count!=1{bail!("Expected exactly one match, found {count}")};fs::write(&path,current.replacen(before,after,1))?;Ok(json!({"path":path,"patched":true}))},
      "shell_exec"=>{let command=args["command"].as_str().context("command is required")?;let cwd=resolve_path(args.get("cwd").unwrap_or(&json!(".")))?;let result=command_exec(json!({"command":command,"cwd":cwd}),tx.clone()).await.map_err(|e|anyhow!(e.message))?;Ok(result)},
      "web_fetch"=>{let url=args["url"].as_str().context("url is required")?;if !(url.starts_with("https://")||url.starts_with("http://")){bail!("Only HTTP(S) URLs are supported")};let response=state.http.get(url).send().await?;let status=response.status();let text=response.text().await?;Ok(json!({"url":url,"status":status.as_u16(),"text":redact_credentials(&text.chars().take(200_000).collect::<String>())}))},
      _=>bail!("Unknown tool: {name}")
    }}.await;
    match result {
        Ok(value) => value,
        Err(error) => {
            json!({"error":"tool_failed","message":error.to_string(),"tool":name,"retryable":true})
        }
    }
}

async fn request_tool_approval(
    state: &AppState,
    name: &str,
    args: &Value,
    workspace: &Path,
    interactive: bool,
    tx: &mpsc::UnboundedSender<Value>,
) -> bool {
    if !interactive {
        return false;
    }
    let id = format!("approval:{}", Uuid::new_v4());
    let (sender, receiver) = oneshot::channel();
    state.approvals.lock().unwrap().insert(id.clone(), sender);
    if tx.send(json!({"jsonrpc":"2.0","id":id,"method":"item/approval/request","params":{"tool":name,"arguments":args,"workspace":workspace,"expires_in":120}})).is_err(){state.approvals.lock().unwrap().remove(&id);return false}
    match tokio::time::timeout(Duration::from_secs(120), receiver).await {
        Ok(Ok(value)) => value,
        _ => {
            state.approvals.lock().unwrap().remove(&id);
            false
        }
    }
}

fn looks_dangerous(command: &str) -> bool {
    let lower = command.to_lowercase();
    [
        "rm -rf",
        "mkfs",
        "dd if=",
        "git push",
        "npm publish",
        "cargo publish",
        "curl | sh",
        "sudo ",
        "passwd",
        "shutdown",
        "reboot",
    ]
    .iter()
    .any(|part| lower.contains(part))
}
fn finish_turn(
    state: &AppState,
    turn_id: &str,
    thread_id: &str,
    item_id: &str,
    result: Result<String>,
    tx: &mpsc::UnboundedSender<Value>,
) {
    let (status, text, error) = match result {
        Ok(v) => ("completed", v, None),
        Err(e) => ("failed", String::new(), Some(e.to_string())),
    };
    let db = state.store.db.lock().unwrap();
    let content_value = match error.as_deref() {
        Some(message) => json!({"text":"","error":message}),
        None => json!({"text":text}),
    };
    let content = state
        .store
        .encrypt(content_value.to_string().as_bytes())
        .unwrap_or_default();
    let _ = db.execute(
        "UPDATE items SET content=?,status=? WHERE id=?",
        params![content, status, item_id],
    );
    let _ = db.execute(
        "UPDATE turns SET status=?,completed_at=?,error=? WHERE id=?",
        params![status, now(), error, turn_id],
    );
    let _ = db.execute(
        "UPDATE threads SET status=?,updated_at=? WHERE id=?",
        params![
            if status == "completed" {
                "idle"
            } else {
                "failed"
            },
            now(),
            thread_id
        ],
    );
    if let Some(error) = error.as_deref() {
        eprintln!("turn {turn_id} failed: {error}");
        tx.send(notification("item/completed",json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":item_id,"status":"failed","error":error}))).ok();
    } else {
        tx.send(notification(
            "item/completed",
            json!({"thread_id":thread_id,"turn_id":turn_id,"item_id":item_id,"status":"completed"}),
        ))
        .ok();
    }
    tx.send(notification(
        "turn/completed",
        json!({"thread_id":thread_id,"turn_id":turn_id,"status":status,"error":error}),
    ))
    .ok();
}
async fn turn_interrupt(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let id = required_str(&p, "turn_id")?;
    if let Some(handle) = state.turns.write().await.remove(id) {
        handle.abort();
        let db = state.store.db.lock().unwrap();
        db.execute(
            "UPDATE turns SET status='interrupted',completed_at=? WHERE id=?",
            params![now(), id],
        )
        .map_err(anyhow::Error::from)?;
        Ok(json!({"interrupted":true}))
    } else {
        Err(RpcFailure::new(-32004, "Running turn not found"))
    }
}

fn permission_profiles() -> Value {
    json!({"profiles":[{"id":"deny_all","name":"Deny All"},{"id":"allow_low_risk","name":"Allow Low-Risk"},{"id":"always_ask","name":"Always Ask"},{"id":"full_access","name":"Full Access","tone":"warning","ask_rules":["broad deletion","publishing","payments","credentials","destructive out-of-workspace actions"]}]})
}
fn permission_set(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let profile = required_str(&p, "profile")?;
    if !["deny_all", "allow_low_risk", "always_ask", "full_access"].contains(&profile) {
        return Err(RpcFailure::new(-32602, "Unknown permission profile"));
    }
    let scope = p
        .get("workspace")
        .and_then(Value::as_str)
        .map(|v| {
            format!(
                "workspace:{}",
                canonical_workspace(v).unwrap_or_else(|_| v.to_owned())
            )
        })
        .unwrap_or("global".into());
    config_write(
        state,
        json!({"scope":scope,"key":"permission_profile","value":profile}),
    )
}
fn config_read(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    if p.get("key").is_none() {
        return layered_config(
            state,
            p.get("workspace").and_then(Value::as_str).unwrap_or("."),
        );
    }
    let scope = p.get("scope").and_then(Value::as_str).unwrap_or("global");
    let key = required_str(&p, "key")?;
    let encrypted: Option<Vec<u8>> = state
        .store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT value FROM config WHERE scope=? AND key=?",
            params![scope, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(anyhow::Error::from)?;
    Ok(
        json!({"scope":scope,"key":key,"value":encrypted.and_then(|v|state.store.decrypt(&v).ok()).and_then(|v|serde_json::from_slice::<Value>(&v).ok())}),
    )
}
fn config_write(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let scope = p.get("scope").and_then(Value::as_str).unwrap_or("global");
    let key = required_str(&p, "key")?;
    let value = p.get("value").cloned().unwrap_or(Value::Null);
    let encrypted = state.store.encrypt(value.to_string().as_bytes())?;
    state.store.db.lock().unwrap().execute("INSERT INTO config(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value",params![scope,key,encrypted]).map_err(anyhow::Error::from)?;
    Ok(json!({"ok":true}))
}

fn config_batch_write(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let writes = p
        .get("writes")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcFailure::new(-32602, "writes is required"))?;
    let db = state.store.db.lock().unwrap();
    let mut statement=db.prepare("INSERT INTO config(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").map_err(anyhow::Error::from)?;
    for write in writes {
        let scope = write
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("global");
        let key = required_str(write, "key")?;
        let value = write.get("value").cloned().unwrap_or(Value::Null);
        let encrypted = state.store.encrypt(value.to_string().as_bytes())?;
        statement
            .execute(params![scope, key, encrypted])
            .map_err(anyhow::Error::from)?;
    }
    Ok(json!({"ok":true,"written":writes.len()}))
}

fn layered_config(state: &AppState, workspace: &str) -> std::result::Result<Value, RpcFailure> {
    let workspace = fs::canonicalize(workspace).unwrap_or_else(|_| PathBuf::from(workspace));
    let base = directories::BaseDirs::new()
        .ok_or_else(|| RpcFailure::new(-32603, "Could not locate user configuration"))?;
    let candidates = [
        base.config_dir().join("opencode/opencode.json"),
        base.config_dir().join("opencode/opencode.jsonc"),
        base.home_dir().join(".opencode/opencode.jsonc"),
        workspace.join("opencode.json"),
        workspace.join("opencode.jsonc"),
        workspace.join(".opencode/opencode.jsonc"),
        state.control_dir.join("cosaii.jsonc"),
        state.control_dir.join("tui.jsonc"),
        workspace.join(".cosaii/cosaii.jsonc"),
        workspace.join(".cosaii/tui.jsonc"),
        state.control_dir.join("managed.jsonc"),
    ];
    let mut merged = json!({});
    let mut sources = Vec::new();
    let mut diagnostics = Vec::new();
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        match fs::read_to_string(&path).ok().and_then(|text|json5::from_str::<Value>(&text).ok()){Some(value)=>{merge_json(&mut merged,value);sources.push(path)},None=>diagnostics.push(json!({"path":path,"level":"error","message":"Could not parse JSON/JSONC configuration"}))}
    }
    let supported = [
        "$schema",
        "model",
        "provider",
        "providers",
        "agent",
        "agents",
        "command",
        "commands",
        "mode",
        "modes",
        "tools",
        "theme",
        "plugins",
        "skills",
        "instructions",
        "permission",
        "permissions",
        "formatter",
        "formatters",
        "lsp",
        "mcp",
        "mcpServers",
        "reasoning",
    ];
    if let Some(object) = merged.as_object() {
        for key in object.keys() {
            if !supported.contains(&key.as_str()) {
                diagnostics.push(json!({"field":key,"level":"warning","message":"Unsupported configuration field; preserved but not applied"}))
            }
        }
    }
    Ok(
        json!({"config":merged,"sources":sources,"diagnostics":diagnostics,"precedence":["OpenCode global","OpenCode project","Cosaii global","Cosaii project","managed policy"]}),
    )
}
fn merge_json(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge_json(target.entry(key).or_insert(Value::Null), value)
            }
        }
        (target, source) => *target = source,
    }
}
fn skills_list(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let workspace = PathBuf::from(p.get("workspace").and_then(Value::as_str).unwrap_or("."));
    let base = directories::BaseDirs::new()
        .ok_or_else(|| RpcFailure::new(-32603, "Could not locate user configuration"))?;
    let roots = [
        base.config_dir().join("opencode/skills"),
        workspace.join(".opencode/skills"),
        state.control_dir.join("skills"),
        workspace.join(".cosaii/skills"),
    ];
    let mut skills = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let manifest = if path.is_dir() {
                path.join("SKILL.md")
            } else {
                path.clone()
            };
            if manifest.is_file() {
                skills.push(json!({"name":path.file_stem().and_then(|v|v.to_str()).unwrap_or("skill"),"path":manifest,"source":if root.to_string_lossy().contains("opencode"){"opencode"}else{"cosaii"}}))
            }
        }
    }
    Ok(json!({"skills":skills}))
}
fn mcp_list(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    let config = layered_config(
        state,
        p.get("workspace").and_then(Value::as_str).unwrap_or("."),
    )?;
    Ok(
        json!({"servers":config["config"].get("mcp").or_else(||config["config"].get("mcpServers")).cloned().unwrap_or_else(||json!({})),"diagnostics":config["diagnostics"]}),
    )
}

fn fs_read(p: Value) -> std::result::Result<Value, RpcFailure> {
    let path = PathBuf::from(required_str(&p, "path")?);
    let metadata = fs::metadata(&path).map_err(anyhow::Error::from)?;
    if metadata.len() > 8 * 1024 * 1024 {
        return Err(RpcFailure::new(
            -32030,
            "File exceeds the 8 MiB RPC read limit",
        ));
    }
    let bytes = fs::read(&path).map_err(anyhow::Error::from)?;
    match String::from_utf8(bytes.clone()) {
        Ok(text) => Ok(json!({"path":path,"text":redact_credentials(&text),"size":metadata.len()})),
        Err(_) => Ok(json!({"path":path,"base64":STANDARD.encode(bytes),"size":metadata.len()})),
    }
}
fn fs_list(p: Value) -> std::result::Result<Value, RpcFailure> {
    let path = PathBuf::from(p.get("path").and_then(Value::as_str).unwrap_or("."));
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(anyhow::Error::from)? {
        let entry = entry.map_err(anyhow::Error::from)?;
        let meta = entry.metadata().map_err(anyhow::Error::from)?;
        entries.push(json!({"name":entry.file_name(),"path":entry.path(),"directory":meta.is_dir(),"size":meta.len()}));
    }
    Ok(json!({"path":path,"entries":entries}))
}
fn fs_metadata(p: Value) -> std::result::Result<Value, RpcFailure> {
    let path = PathBuf::from(required_str(&p, "path")?);
    let m = fs::metadata(&path).map_err(anyhow::Error::from)?;
    Ok(
        json!({"path":path,"directory":m.is_dir(),"file":m.is_file(),"size":m.len(),"readonly":m.permissions().readonly()}),
    )
}
fn fs_write(p: Value) -> std::result::Result<Value, RpcFailure> {
    let path = PathBuf::from(required_str(&p, "path")?);
    let content = required_str(&p, "text")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(anyhow::Error::from)?;
    }
    fs::write(&path, content).map_err(anyhow::Error::from)?;
    Ok(json!({"path":path,"bytes":content.len(),"changed":true}))
}

async fn command_exec(
    p: Value,
    tx: mpsc::UnboundedSender<Value>,
) -> std::result::Result<Value, RpcFailure> {
    let command = required_str(&p, "command")?;
    let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or(".");
    let item_id = Uuid::new_v4().to_string();
    let mut child = Command::new(if cfg!(windows) { "cmd" } else { "sh" })
        .args(if cfg!(windows) {
            vec!["/C", command]
        } else {
            vec!["-lc", command]
        })
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(anyhow::Error::from)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let txo = tx.clone();
    let iid = item_id.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            txo.send(notification(
                "item/toolCall/outputDelta",
                json!({"item_id":iid,"stream":"stdout","delta":format!("{line}\n")}),
            ))
            .ok();
        }
    });
    let txe = tx.clone();
    let iid2 = item_id.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            txe.send(notification(
                "item/toolCall/outputDelta",
                json!({"item_id":iid2,"stream":"stderr","delta":format!("{line}\n")}),
            ))
            .ok();
        }
    });
    let status = child.wait().await.map_err(anyhow::Error::from)?;
    let _ = tokio::join!(out_task, err_task);
    Ok(json!({"item_id":item_id,"exit_code":status.code(),"success":status.success()}))
}

async fn platform_get(state: &AppState, path: &str) -> std::result::Result<Value, RpcFailure> {
    let access = ensure_access_token(state).await?;
    let response = state
        .http
        .get(format!("{}{}", state.platform, path))
        .bearer_auth(access)
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(anyhow::Error::from)?;
    if !status.is_success() {
        return Err(RpcFailure::new(-32021, format!("Platform returned {status}")).data(value));
    }
    Ok(value)
}
async fn platform_request(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> std::result::Result<Value, RpcFailure> {
    let access = ensure_access_token(state).await?;
    let mut request = state
        .http
        .request(method, format!("{}{}", state.platform, path))
        .bearer_auth(access);
    if let Some(body) = body {
        request = request.json(&body)
    }
    let response = request.send().await.map_err(anyhow::Error::from)?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(RpcFailure::new(-32021, format!("Platform returned {status}")).data(value));
    }
    Ok(value)
}
async fn remote_enable(state: &AppState, p: Value) -> std::result::Result<Value, RpcFailure> {
    if let Some(existing) = state.store.get_secret("remote_environment")? {
        return Ok(serde_json::from_str(&existing).unwrap_or(json!({"enabled":true})));
    }
    let mut private = [0u8; 32];
    rand::rng().fill_bytes(&mut private);
    let secret = StaticSecret::from(private);
    let public = PublicKey::from(&secret);
    let name = p
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(hostname);
    let result = platform_request(
        state,
        reqwest::Method::POST,
        "/cosaii/api/v1/remote/enroll",
        Some(json!({"name":name,"public_key":URL_SAFE_NO_PAD.encode(public.as_bytes())})),
    )
    .await?;
    state.store.put_secret(
        "remote_private_key",
        &URL_SAFE_NO_PAD.encode(secret.to_bytes()),
    )?;
    state.store.put_secret("remote_environment",&json!({"enabled":true,"environment_id":result["environment_id"],"public_key":URL_SAFE_NO_PAD.encode(public.as_bytes()),"connected":false}).to_string())?;
    remote_status(state)
}
fn remote_status(state: &AppState) -> std::result::Result<Value, RpcFailure> {
    Ok(state
        .store
        .get_secret("remote_environment")?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(json!({"enabled":false,"connected":false})))
}
async fn remote_disable(state: &AppState) -> std::result::Result<Value, RpcFailure> {
    if let Some(value) = state.store.get_secret("remote_environment")? {
        if let Ok(value) = serde_json::from_str::<Value>(&value) {
            if let Some(id) = value["environment_id"].as_str() {
                let _ = platform_request(
                    state,
                    reqwest::Method::DELETE,
                    &format!("/cosaii/api/v1/remote/environments/{id}"),
                    None,
                )
                .await;
            }
        }
    }
    let db = state.store.db.lock().unwrap();
    db.execute(
        "DELETE FROM credentials WHERE name IN ('remote_environment','remote_private_key')",
        [],
    )
    .map_err(anyhow::Error::from)?;
    Ok(json!({"enabled":false,"connected":false}))
}
async fn remote_pair(state: &AppState) -> std::result::Result<Value, RpcFailure> {
    let status = remote_status(state)?;
    let id = status["environment_id"]
        .as_str()
        .ok_or_else(|| RpcFailure::new(-32040, "Enable remote control first"))?;
    platform_request(
        state,
        reqwest::Method::POST,
        "/cosaii/api/v1/remote/pairing/start",
        Some(json!({"environment_id":id})),
    )
    .await
}
async fn remote_clients(state: &AppState) -> std::result::Result<Value, RpcFailure> {
    let status = remote_status(state)?;
    let id = status["environment_id"]
        .as_str()
        .ok_or_else(|| RpcFailure::new(-32040, "Enable remote control first"))?;
    platform_get(
        state,
        &format!("/cosaii/api/v1/remote/clients?environment_id={id}"),
    )
    .await
}
async fn ensure_access_token(state: &AppState) -> std::result::Result<String, RpcFailure> {
    let access = state
        .store
        .get_secret("access_token")?
        .ok_or_else(|| RpcFailure::new(-32022, "Sign in with cosaii login first"))?;
    let probe = state
        .http
        .get(format!("{}/cosaii/api/v1/bootstrap", state.platform))
        .bearer_auth(&access)
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    if probe.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(access);
    }
    let refresh = state
        .store
        .get_secret("refresh_token")?
        .ok_or_else(|| RpcFailure::new(-32022, "Cosaii login expired"))?;
    let response = state
        .http
        .post(format!("{}/platform/api/cli/token/refresh", state.platform))
        .json(&json!({"refresh_token":refresh}))
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    if !response.status().is_success() {
        return Err(RpcFailure::new(
            -32022,
            "Cosaii login expired; run cosaii login",
        ));
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(anyhow::Error::from)?;
    let access = body["access_token"].as_str().unwrap_or_default().to_owned();
    state.store.put_secret("access_token", &access)?;
    state.store.put_secret(
        "refresh_token",
        body["refresh_token"].as_str().unwrap_or_default(),
    )?;
    Ok(access)
}

async fn proxy_stdio(args: Args) -> Result<()> {
    let (control, _) = home_paths(&args)?;
    #[cfg(unix)]
    let stream = UnixStream::connect(
        args.listen
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| control.join("app-server.sock")),
    )
    .await?;
    #[cfg(windows)]
    let stream: NamedPipeClient = ClientOptions::new().open(
        args.listen
            .as_deref()
            .map(str::to_owned)
            .unwrap_or_else(default_windows_pipe),
    )?;
    let (ws, _) = tokio_tungstenite::client_async("ws://localhost/", stream).await?;
    let (mut write, mut read) = ws.split();
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    loop {
        tokio::select! {line=stdin.next_line()=>match line?{Some(line)=>write.send(Message::Text(line.into())).await?,None=>break},message=read.next()=>match message{Some(Ok(Message::Text(text)))=>{stdout.write_all(text.as_bytes()).await?;stdout.write_all(b"\n").await?;stdout.flush().await?},Some(Ok(_))=>{},Some(Err(e))=>return Err(e.into()),None=>break}}
    }
    Ok(())
}

#[cfg(windows)]
fn default_windows_pipe() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    let safe = user
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    format!(r"\\.\pipe\cosaii-app-server-{safe}")
}

fn thread_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"workspace":row.get::<_,String>(2)?,"model":row.get::<_,String>(3)?,"reasoning":row.get::<_,String>(4)?,"permission_profile":row.get::<_,String>(5)?,"status":row.get::<_,String>(6)?,"pinned":row.get::<_,bool>(7)?,"archived":row.get::<_,bool>(8)?,"created_at":row.get::<_,String>(9)?,"updated_at":row.get::<_,String>(10)?}),
    )
}
fn insert_item(
    store: &Store,
    db: &Connection,
    id: &str,
    turn_id: &str,
    ordinal: i64,
    kind: &str,
    content: &Value,
    status: &str,
) -> std::result::Result<(), RpcFailure> {
    let encrypted = store.encrypt(content.to_string().as_bytes())?;
    db.execute("INSERT INTO items(id,turn_id,ordinal,kind,content,status,created_at) VALUES(?,?,?,?,?,?,?)",params![id,turn_id,ordinal,kind,encrypted,status,now()]).map_err(anyhow::Error::from)?;
    Ok(())
}
fn required_str<'a>(p: &'a Value, key: &str) -> std::result::Result<&'a str, RpcFailure> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| RpcFailure::new(-32602, format!("{key} is required")))
}
fn canonical_workspace(path: &str) -> std::result::Result<String, RpcFailure> {
    fs::canonicalize(path)
        .map(|v| v.to_string_lossy().into_owned())
        .map_err(|e| RpcFailure::new(-32602, format!("Invalid workspace: {e}")))
}
fn success_response(id: RpcId, result: Value) -> Value {
    serde_json::to_value(RpcResponse {
        jsonrpc: "2.0".into(),
        id,
        result: Some(result),
        error: None,
    })
    .unwrap()
}
fn rpc_id_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn error_response(id: RpcId, code: i32, message: &str, data: Option<Value>) -> Value {
    serde_json::to_value(RpcResponse {
        jsonrpc: "2.0".into(),
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.into(),
            data,
        }),
    })
    .unwrap()
}
fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","method":method,"params":params})
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "Cosaii device".into())
}
fn redact_credentials(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            if word.starts_with("sk-") || word.starts_with("ghp_") || word.starts_with("cosaii_at_")
            {
                "[REDACTED]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn recorded_process_alive(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        return false;
    };
    #[cfg(unix)]
    {
        unsafe { libc_kill_zero(pid) }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}
#[cfg(unix)]
unsafe fn libc_kill_zero(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}
#[cfg(unix)]
fn restrict_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
#[cfg(not(unix))]
fn restrict_dir(_: &Path) -> Result<()> {
    Ok(())
}
#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(not(unix))]
fn restrict_file(_: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_records_round_trip_and_do_not_contain_plaintext() {
        let key = [7u8; 32];
        let store = Store {
            db: Mutex::new(Connection::open_in_memory().unwrap()),
            cipher: XChaCha20Poly1305::new((&key).into()),
        };
        let plaintext = b"private conversation text";
        let encrypted = store.encrypt(plaintext).unwrap();
        assert!(
            !encrypted
                .windows(plaintext.len())
                .any(|window| window == plaintext)
        );
        assert_eq!(store.decrypt(&encrypted).unwrap(), plaintext);
    }

    #[test]
    fn permission_presets_and_sensitive_command_rules_are_stable() {
        let profiles = permission_profiles().to_string();
        for expected in ["deny_all", "allow_low_risk", "always_ask", "full_access"] {
            assert!(profiles.contains(expected));
        }
        assert!(looks_dangerous("git push origin main"));
        assert!(looks_dangerous("rm -rf build"));
        assert!(!looks_dangerous("cargo test"));
    }

    #[test]
    fn layered_merge_preserves_nested_values_and_overrides_later_values() {
        let mut target = json!({"permission":{"shell":"ask"},"model":"fast"});
        merge_json(
            &mut target,
            json!({"permission":{"read":"allow"},"model":"smart"}),
        );
        assert_eq!(target["model"], "smart");
        assert_eq!(target["permission"]["shell"], "ask");
        assert_eq!(target["permission"]["read"], "allow");
    }

    #[test]
    fn credential_redaction_covers_supported_token_prefixes() {
        let value = redact_credentials("use sk-secret ghp_token cosaii_at_token safely");
        assert_eq!(value.matches("[REDACTED]").count(), 3);
    }
}
