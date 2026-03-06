# Austhai UAV Line Planner - Installation Guide

This guide explains how to install and run the desktop app, and how to generate installer files for other users.

## 1) End-User Install (No VS Code / No Node.js Required)

Use this section for users who only need to install and use the app.

### Files to Share

From the `release` folder, share one of these:

- `Austhai UAV Line Planner Setup 1.0.0.exe` (recommended installer)
- `Austhai UAV Line Planner 1.0.0.exe` (portable, no install)

### Option A - NSIS Setup Installer (Recommended)

**Why use NSIS installer?**
- Proper Windows integration (Start Menu, Control Panel uninstaller)
- Smaller download size (~110 MB vs ~96 MB portable, but better compression)
- Automatic updates support (if configured)
- Better user experience with installation wizard

**Installation Steps:**

1. Copy `Austhai UAV Line Planner Setup 1.0.0.exe` to the target PC.
2. Right-click the file and select **Run as administrator** (recommended for smoother setup).
3. If Windows SmartScreen appears:
   - Click **More info**
   - Click **Run anyway**
4. In the installer wizard:
   - Select installation folder (default: `C:\Users\[YourName]\AppData\Local\Programs\austhai-uav-line-planner`)
   - Keep **Create Desktop Shortcut** enabled
   - Click **Install**
5. Click **Finish** to launch the app.
6. Open the app from:
   - Desktop shortcut, or
   - Start Menu: **Austhai UAV Line Planner**

### Option B - Portable EXE (No Installation)

1. Copy `Austhai UAV Line Planner 1.0.0.exe` to any folder (for example `C:\Apps\Austhai`).
2. Double-click the EXE to run.
3. Optional: create a desktop shortcut manually.

### First Launch Checklist

After opening the app, verify:

1. Map loads correctly.
2. You can upload your AOI file (`.zip` shapefile, `.kml`, `.kmz`, `.geojson`).
3. You can generate flight lines and tie lines.
4. Export works for GeoJSON, KML, KMZ, and CSV ZIP output.

## 2) Build Installer for Distribution (Developer Machine)

Use this section when you want to produce new installer files.

### Prerequisites

1. Windows 10/11
2. Node.js installed (or local portable Node in project)
3. Project dependencies installed

### Build Steps

1. Open terminal in project root.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Build app and package installer:

   **Option A: Build NSIS Installer Only (Recommended)**
   ```bash
   npm run build:vite
   npm run build:electron
   npx electron-builder --win nsis --x64
   ```

   **Option B: Build Both NSIS and Portable**
   ```bash
   npm run build
   ```

4. Wait until build completes (typically 2-3 minutes).
5. Check output in `release` folder:
   - `Austhai UAV Line Planner Setup 1.0.0.exe` (NSIS installer, ~110 MB)
   - `Austhai UAV Line Planner 1.0.0.exe` (portable, ~96 MB) - if Option B used

## 3) Uninstall Guide (End Users)

### If installed via Setup EXE

1. Open **Settings > Apps > Installed apps**.
2. Find **Austhai UAV Line Planner**.
3. Click **Uninstall**.

### If using portable EXE

1. Delete the EXE file.
2. Delete any created shortcut.

## 4) Troubleshooting

### "Windows protected your PC"

- Click **More info** then **Run anyway**.

### App does not start

1. Right-click EXE > **Run as administrator**.
2. Ensure antivirus is not quarantining the file.
3. Move app to a simple path (for example `C:\Apps\Austhai`).

### Build fails on developer machine

1. Delete `node_modules` and `package-lock.json`.
2. Run `npm install` again.
3. Re-run `npm run build`.

### Installer generation stops before EXE creation

1. Close all running `electron`, `node`, and `app-builder` processes.
2. Clear old artifacts in `release`.
3. Re-run `npm run build`.

## 5) Recommended Distribution Package

For non-technical users, distribute only:

1. `Austhai UAV Line Planner Setup 1.0.0.exe`
2. A short note:
   - "Run installer as administrator"
   - "If SmartScreen appears, click More info > Run anyway"
