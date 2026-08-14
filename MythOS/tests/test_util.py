from pathlib import Path

from mythos.util import atomic_write, bytes_to_human, is_device_path, safe_name


def test_atomic_write_and_helpers(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "value"
    atomic_write(target, "ready\n", mode=0o600)
    assert target.read_text(encoding="utf-8") == "ready\n"
    assert target.stat().st_mode & 0o777 == 0o600
    assert bytes_to_human(1024**3) == "1.0 GiB"
    assert safe_name("../Odd !$ Name.exe") == "Odd  Name.exe"


def test_device_path_validation() -> None:
    assert is_device_path("/dev/nvme0n1p2")
    assert is_device_path("/dev/mapper/consumer-root")
    assert not is_device_path("/tmp/disk")
    assert not is_device_path("/dev/../etc/passwd")

