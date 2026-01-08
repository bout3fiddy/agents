#!/bin/bash
set -e

echo "Chrome DevTools - System Dependencies Installer"
echo "================================================"

detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ -f /etc/os-release ]]; then
        . /etc/os-release
        echo "$ID"
    else
        echo "unknown"
    fi
}

OS=$(detect_os)
echo "Detected OS: $OS"

case $OS in
    macos)
        echo "macOS detected - Chrome dependencies are bundled. No action needed."
        ;;
    ubuntu|debian)
        echo "Installing Chrome dependencies for Ubuntu/Debian..."
        sudo apt-get update
        sudo apt-get install -y \
            libnss3 \
            libnspr4 \
            libasound2t64 \
            libatk1.0-0 \
            libatk-bridge2.0-0 \
            libcups2 \
            libdrm2 \
            libxkbcommon0 \
            libxcomposite1 \
            libxdamage1 \
            libxfixes3 \
            libxrandr2 \
            libgbm1 \
            libpango-1.0-0 \
            libcairo2 \
            fonts-liberation \
            xdg-utils
        echo "Dependencies installed successfully."
        ;;
    fedora|rhel|centos)
        echo "Installing Chrome dependencies for Fedora/RHEL/CentOS..."
        sudo dnf install -y \
            nss \
            nspr \
            alsa-lib \
            atk \
            at-spi2-atk \
            cups-libs \
            libdrm \
            libxkbcommon \
            libXcomposite \
            libXdamage \
            libXfixes \
            libXrandr \
            mesa-libgbm \
            pango \
            cairo \
            liberation-fonts
        echo "Dependencies installed successfully."
        ;;
    arch|manjaro)
        echo "Installing Chrome dependencies for Arch/Manjaro..."
        sudo pacman -S --needed --noconfirm \
            nss \
            nspr \
            alsa-lib \
            atk \
            at-spi2-atk \
            cups \
            libdrm \
            libxkbcommon \
            libxcomposite \
            libxdamage \
            libxfixes \
            libxrandr \
            mesa \
            pango \
            cairo \
            ttf-liberation
        echo "Dependencies installed successfully."
        ;;
    *)
        echo "Unknown OS. Please install Chrome dependencies manually."
        echo "Required packages: nss, nspr, alsa-lib, atk, cups, libdrm, libxkbcommon, pango, cairo"
        exit 1
        ;;
esac

echo ""
echo "Next steps:"
echo "1. Run: npm install"
echo "2. Test: node navigate.js --url https://example.com"
