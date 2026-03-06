# Austhai UAV Line Planner

A desktop application for UAV (drone) flight path planning and management, built with Electron, React, and Leaflet.

## Features

- Interactive map-based flight path planning
- Import/export KML, GPX, and Shapefile formats
- AI-powered flight optimization (Gemini AI)
- Offline SQLite database for mission storage
- Cross-platform desktop application

## Development

### Prerequisites

- Node.js 22 or higher
- Git

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables (optional for AI features):**
   - Copy `.env.example` to `.env.local`
   - Add your `GEMINI_API_KEY` for AI features

3. **Run in development mode:**
   ```bash
   npm run dev
   ```

   This will:
   - Build the Electron main process
   - Start Vite dev server on port 5173
   - Launch the Electron app

### Build Scripts

- `npm run dev` - Run app in development mode
- `npm run build:vite` - Build React frontend
- `npm run build:electron` - Compile Electron TypeScript
- `npm run build` - Full production build with installer

## Building Installers

### Automated Build (GitHub Actions)

The easiest way to build installers is using GitHub Actions:

1. **Navigate to Actions tab:**
   - Go to: https://github.com/diazrayemmanuel-eng/Austhai-UAV-Line-Planner/actions

2. **Trigger a build:**
   - Click "Build Windows Desktop App" workflow
   - Click "Run workflow" button
   - Select "main" branch
   - Click "Run workflow"

3. **Download the installer:**
   - Wait for the build to complete (~5-10 minutes)
   - Click on the completed workflow run
   - Download artifacts under "Artifacts" section
   - Extract and find `Austhai UAV Line Planner Setup 1.0.0.exe`

### Local Build (Alternative)

If you need to build locally:

```bash
npm run build
```

⚠️ **Note:** Local builds may experience hanging issues with electron-builder. GitHub Actions is the recommended build method.

## Project Structure

```
├── electron/           # Electron main process & preload scripts
├── src/               # React frontend source
├── public/            # Static assets
├── dist/              # Built frontend (generated)
├── dist-electron/     # Built Electron code (generated)
├── release/           # Final installers (generated)
└── .github/workflows/ # GitHub Actions CI/CD
```

## Technologies

- **Frontend:** React 19, TypeScript, Tailwind CSS
- **Desktop:** Electron
- **Mapping:** Leaflet, React-Leaflet
- **AI:** Google Gemini API
- **Database:** better-sqlite3
- **Build:** Vite, electron-builder

## License

See LICENSE file for details.
