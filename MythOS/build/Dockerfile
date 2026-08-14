FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        apt-utils \
        build-essential \
        ca-certificates \
        debhelper \
        debootstrap \
        devscripts \
        dh-python \
        dosfstools \
        dpkg-dev \
        git \
        grub-efi-amd64-bin \
        grub-pc-bin \
        isolinux \
        live-build \
        mtools \
        pybuild-plugin-pyproject \
        python3-all \
        python3-pytest \
        python3-setuptools \
        rsync \
        shellcheck \
        shim-signed \
        squashfs-tools \
        syslinux-common \
        xorriso \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
