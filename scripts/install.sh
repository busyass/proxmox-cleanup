#!/bin/bash
# Proxmox Cleanup - Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/hiall-fyi/proxmox-cleanup/main/scripts/install.sh | bash

# Exit on error, but with cleanup
set -eE

# Configuration
REPO_URL="https://github.com/hiall-fyi/proxmox-cleanup.git"
INSTALL_DIR="/opt/proxmox-cleanup"
CONFIG_DIR="/etc/proxmox-cleanup"
LOG_DIR="/var/log/proxmox-cleanup"
BACKUP_DIR="/var/backups/proxmox-cleanup"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Track installation state for cleanup
INSTALLATION_STARTED=false
REPO_CLONED=false
GLOBALLY_INSTALLED=false

# Cleanup on failure
cleanup_on_failure() {
    local exit_code=$?
    if [ $exit_code -ne 0 ] && [ "$INSTALLATION_STARTED" = true ]; then
        log_error "Installation failed with exit code $exit_code"
        log_info "Cleaning up..."
        
        # Remove global installation if it was just installed
        if [ "$GLOBALLY_INSTALLED" = true ]; then
            npm uninstall -g proxmox-cleanup 2>/dev/null || true
        fi
        
        log_info "Cleanup completed. You can retry the installation."
    fi
}

trap cleanup_on_failure ERR EXIT

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root"
        log_info "Usage: sudo bash install.sh"
        exit 1
    fi
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_warning "Node.js not found. Installing..."
        if ! apt update; then
            log_error "Failed to update apt repositories"
            exit 1
        fi
        if ! apt install -y nodejs npm; then
            log_error "Failed to install Node.js"
            exit 1
        fi
        log_success "Node.js installed"
    fi
    
    # Verify Node.js version
    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        log_error "Node.js version 18+ required. Current: $(node --version)"
        log_info "Please upgrade Node.js: https://nodejs.org/"
        exit 1
    fi
    log_success "Node.js $(node --version) found"
    
    # Check Git
    if ! command -v git &> /dev/null; then
        log_warning "Git not found. Installing..."
        if ! apt install -y git; then
            log_error "Failed to install Git"
            exit 1
        fi
        log_success "Git installed"
    else
        log_success "Git $(git --version | cut -d' ' -f3) found"
    fi
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Please install Docker first."
        log_info "Install Docker: https://docs.docker.com/engine/install/"
        exit 1
    fi
    log_success "Docker $(docker --version | cut -d' ' -f3 | cut -d',' -f1) found"
    
    # Check if Docker daemon is running
    if ! docker ps &> /dev/null; then
        log_error "Docker daemon is not running. Please start Docker first."
        log_info "Start Docker: sudo systemctl start docker"
        exit 1
    fi
    log_success "Docker daemon is running"
}

# Clone or update repository
setup_repository() {
    log_info "Setting up repository..."
    
    if [ -d "$INSTALL_DIR" ]; then
        log_info "Updating existing installation..."
        cd "$INSTALL_DIR"
        
        # Backup current config if exists
        if [ -f "$CONFIG_DIR/config.json" ]; then
            local backup_file="$CONFIG_DIR/config.json.backup.$(date +%Y%m%d_%H%M%S)"
            cp "$CONFIG_DIR/config.json" "$backup_file"
            log_info "Backed up existing configuration to $backup_file"
        fi
        
        # Reset any local changes to avoid conflicts
        git reset --hard HEAD
        git clean -fd
        
        # Pull latest changes
        if ! git pull origin main; then
            log_error "Failed to update repository"
            exit 1
        fi
        log_success "Repository updated"
    else
        log_info "Cloning repository..."
        if ! git clone "$REPO_URL" "$INSTALL_DIR"; then
            log_error "Failed to clone repository"
            exit 1
        fi
        cd "$INSTALL_DIR"
        REPO_CLONED=true
        log_success "Repository cloned"
    fi
}

# Install dependencies and build
build_project() {
    log_info "Installing dependencies..."
    cd "$INSTALL_DIR"
    
    # Clean previous build
    rm -rf node_modules/ dist/
    
    # Install dependencies
    if ! npm install; then
        log_error "Failed to install dependencies"
        exit 1
    fi
    log_success "Dependencies installed"
    
    # Build project
    log_info "Building project..."
    if ! npm run build; then
        log_error "Failed to build project"
        exit 1
    fi
    
    # Verify build output
    if [ ! -f "dist/cli/index.js" ]; then
        log_error "Build succeeded but dist/cli/index.js not found"
        exit 1
    fi
    log_success "Project built successfully"
    
    # Run tests (optional, don't fail on test errors)
    log_info "Running tests..."
    if npm test 2>/dev/null; then
        log_success "All tests passed"
    else
        log_warning "Some tests failed, but continuing installation"
    fi
}

# Install globally
install_globally() {
    log_info "Installing globally..."
    cd "$INSTALL_DIR"
    
    # Verify dist directory exists
    if [ ! -d "dist" ] || [ ! -f "dist/cli/index.js" ]; then
        log_error "Build output not found. Cannot install globally."
        exit 1
    fi
    
    # Uninstall previous version if exists
    if npm list -g proxmox-cleanup &> /dev/null; then
        log_info "Removing previous global installation..."
        npm uninstall -g proxmox-cleanup
    fi
    
    # Install globally (without --production, dist is already built)
    if ! npm install -g .; then
        log_error "Failed to install globally"
        exit 1
    fi
    GLOBALLY_INSTALLED=true
    log_success "Installed globally"
}

# Setup configuration
setup_configuration() {
    log_info "Setting up configuration..."
    
    # Create directories
    mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$BACKUP_DIR"
    
    # Set permissions
    chown root:root "$CONFIG_DIR" "$LOG_DIR" "$BACKUP_DIR"
    chmod 755 "$CONFIG_DIR" "$LOG_DIR" "$BACKUP_DIR"
    
    # Copy example config if not exists
    if [ ! -f "$CONFIG_DIR/config.json" ]; then
        if [ ! -f "$INSTALL_DIR/config.example.json" ]; then
            log_error "config.example.json not found in repository"
            exit 1
        fi
        
        cp "$INSTALL_DIR/config.example.json" "$CONFIG_DIR/config.json"
        
        # Update paths in config (safer approach)
        local temp_config=$(mktemp)
        if jq --arg backup "$BACKUP_DIR" --arg logs "$LOG_DIR" \
            '.cleanup.backupPath = $backup | .reporting.logPath = $logs' \
            "$CONFIG_DIR/config.json" > "$temp_config" 2>/dev/null; then
            mv "$temp_config" "$CONFIG_DIR/config.json"
        else
            # Fallback to sed if jq not available
            sed -i "s|\"./backups\"|\"$BACKUP_DIR\"|g" "$CONFIG_DIR/config.json"
            sed -i "s|\"./logs\"|\"$LOG_DIR\"|g" "$CONFIG_DIR/config.json"
        fi
        
        # Secure config file
        chmod 600 "$CONFIG_DIR/config.json"
        chown root:root "$CONFIG_DIR/config.json"
        
        log_success "Created configuration file"
        log_warning "Please edit $CONFIG_DIR/config.json with your Proxmox settings!"
    else
        log_info "Configuration file already exists (not overwriting)"
    fi
}

# Create update script
create_update_script() {
    log_info "Creating update script..."
    
    cat > /usr/local/bin/update-proxmox-cleanup << 'EOF'
#!/bin/bash
set -e

INSTALL_DIR="/opt/proxmox-cleanup"

echo "🔄 Updating Proxmox Cleanup..."

if [ ! -d "$INSTALL_DIR" ]; then
    echo "❌ Installation directory not found. Please reinstall."
    exit 1
fi

cd "$INSTALL_DIR"

# Save current version
CURRENT_VERSION=$(proxmox-cleanup --version 2>/dev/null || echo "unknown")
echo "📌 Current version: $CURRENT_VERSION"

# Pull latest changes
echo "📥 Pulling latest changes..."
git reset --hard HEAD
git clean -fd
git pull origin main

# Reinstall dependencies and rebuild
echo "📦 Installing dependencies..."
npm install

echo "🔨 Building project..."
npm run build

# Verify build
if [ ! -f "dist/cli/index.js" ]; then
    echo "❌ Build failed - dist/cli/index.js not found"
    exit 1
fi

# Reinstall globally
echo "🌍 Reinstalling globally..."
npm install -g .

# Verify new version
NEW_VERSION=$(proxmox-cleanup --version 2>/dev/null || echo "unknown")
echo "✅ Update completed!"
echo "📌 New version: $NEW_VERSION"

# Show what changed
if [ "$CURRENT_VERSION" != "$NEW_VERSION" ]; then
    echo ""
    echo "🎉 Successfully updated from $CURRENT_VERSION to $NEW_VERSION"
else
    echo ""
    echo "ℹ️  Version unchanged: $NEW_VERSION"
fi
EOF
    
    chmod +x /usr/local/bin/update-proxmox-cleanup
    log_success "Update script created at /usr/local/bin/update-proxmox-cleanup"
}

# Setup systemd service
setup_systemd_service() {
    log_info "Setting up systemd service..."
    
    cat > /etc/systemd/system/proxmox-cleanup.service << EOF
[Unit]
Description=Proxmox Docker Cleanup
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
WorkingDirectory=$CONFIG_DIR
ExecStart=/usr/local/bin/proxmox-cleanup cleanup -c $CONFIG_DIR/config.json
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable proxmox-cleanup.service
    log_success "Systemd service created and enabled"
}

# Setup log rotation
setup_logrotate() {
    log_info "Setting up log rotation..."
    
    cat > /etc/logrotate.d/proxmox-cleanup << EOF
$LOG_DIR/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 root root
}
EOF

    # Report and summary files are pruned by the tool itself (reporting.keepReports
    # in config.json), because they are not *.log and an npm-installed copy never
    # runs this installer.
    
    log_success "Log rotation configured"
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."
    
    # Check if command is available
    if ! command -v proxmox-cleanup &> /dev/null; then
        log_error "proxmox-cleanup command not found in PATH"
        log_info "PATH: $PATH"
        log_info "npm global bin: $(npm config get prefix)/bin"
        exit 1
    fi
    
    # Check version
    local version
    if ! version=$(proxmox-cleanup --version 2>&1); then
        log_error "Failed to get version: $version"
        exit 1
    fi
    log_success "proxmox-cleanup $version installed successfully"
    
    # Test basic functionality
    if ! proxmox-cleanup --help &> /dev/null; then
        log_error "Command line interface not working"
        exit 1
    fi
    log_success "Command line interface working"
}

# Display next steps
show_next_steps() {
    echo ""
    echo "🎉 Installation completed successfully!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Edit configuration:"
    echo "   nano $CONFIG_DIR/config.json"
    echo ""
    echo "2. Test configuration:"
    echo "   proxmox-cleanup validate-config -c $CONFIG_DIR/config.json"
    echo ""
    echo "3. Run dry-run test:"
    echo "   proxmox-cleanup dry-run -c $CONFIG_DIR/config.json"
    echo ""
    echo "4. Perform actual cleanup:"
    echo "   proxmox-cleanup cleanup -c $CONFIG_DIR/config.json"
    echo ""
    echo "📚 Documentation:"
    echo "   - Documentation: $INSTALL_DIR/README.md"
    echo "   - README: $INSTALL_DIR/README.md"
    echo ""
    echo "🔄 To update in the future:"
    echo "   update-proxmox-cleanup"
    echo ""
    echo "🗂️ Important paths:"
    echo "   - Config: $CONFIG_DIR/config.json"
    echo "   - Logs: $LOG_DIR/"
    echo "   - Backups: $BACKUP_DIR/"
    echo "   - Source: $INSTALL_DIR/"
    echo ""
}

# Main installation function
main() {
    echo "🚀 Proxmox Cleanup - Installation Script"
    echo "========================================="
    echo ""
    
    INSTALLATION_STARTED=true
    
    check_root
    check_prerequisites
    setup_repository
    build_project
    install_globally
    setup_configuration
    create_update_script
    setup_systemd_service
    setup_logrotate
    verify_installation
    show_next_steps
    
    # Installation succeeded, disable cleanup trap
    trap - ERR EXIT
}

# Run main function
main "$@"
