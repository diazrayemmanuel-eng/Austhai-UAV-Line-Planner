/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, GeoJSON, useMap, Marker, Tooltip as LeafletTooltip } from 'react-leaflet';
import * as turf from '@turf/turf';
import shp from 'shpjs';
import { kml } from '@tmcw/togeojson';
import tokml from 'tokml';
import JSZip from 'jszip';
import type { Feature, Polygon, MultiPolygon, LineString, FeatureCollection, BBox } from 'geojson';
import { 
  Upload, 
  Settings2, 
  Download, 
  Map as MapIcon, 
  Layers, 
  ChevronRight, 
  Info,
  Trash2,
  Maximize2,
  Navigation,
  Eye,
  X,
  Palette,
  ArrowLeftRight,
  MousePointer2,
  RotateCcw,
  GripVertical,
  Monitor,
  Activity,
  Loader2,
  Wifi,
  WifiOff
} from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer, AreaChart, Area 
} from 'recharts';
import html2canvas from 'html2canvas';
import { AnimatePresence, motion } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import austaThaiLogo from '../Austhai logo.jpg';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface PlanningSettings {
  flightLineSpacing: number; // meters
  tieLineSpacing: number;    // meters
  angle: number;             // degrees
  overlap: number;           // percentage (not used for line gen but good for UI)
  flightLineColor: string;
  tieLineColor: string;
  boundaryColor: string;
  swapDirections: boolean;
  lineExtension: number; // meters
  gridOffsetX: number;   // meters
  gridOffsetY: number;   // meters
}

// --- Helpers ---

/**
 * Generates parallel lines across a polygon at a given spacing and angle.
 */
function generateLines(
  polygon: Feature<Polygon | MultiPolygon>,
  spacingMeters: number,
  angleDegrees: number,
  extensionMeters: number = 0,
  gridOffsetMeters: number = 0
): FeatureCollection<LineString> {
  if (!polygon || spacingMeters <= 0) return turf.featureCollection([]);

  // Use a fixed reference point (rounded to nearest degree) to ensure grid alignment across different polygons
  const polyCenter = turf.center(polygon);
  const pivot = turf.point([
    Math.floor(polyCenter.geometry.coordinates[0]),
    Math.floor(polyCenter.geometry.coordinates[1])
  ]);
  
  // 1. Rotate the polygon by -angle
  const rotatedPoly = turf.transformRotate(polygon, -angleDegrees, { pivot });
  const bbox = turf.bbox(rotatedPoly);
  
  // 2. Calculate spacing in degrees at the pivot location
  const p2 = turf.destination(pivot, spacingMeters / 1000, 0, { units: 'kilometers' });
  const latSpacing = Math.abs(p2.geometry.coordinates[1] - pivot.geometry.coordinates[1]);
  
  // Calculate offset in degrees
  const offsetDeg = (gridOffsetMeters / spacingMeters) * latSpacing;
  
  const lines: Feature<LineString>[] = [];
  
  const minX = bbox[0];
  const minY = bbox[1];
  const maxX = bbox[2];
  const maxY = bbox[3];

  // 3. Generate lines based on a fixed grid relative to the pivot
  // This ensures that two adjacent polygons will have aligned lines
  const startY = Math.floor((minY - pivot.geometry.coordinates[1]) / latSpacing) * latSpacing + pivot.geometry.coordinates[1] + offsetDeg;
  const endY = maxY + latSpacing;

  for (let y = startY; y <= endY; y += latSpacing) {
    // Create a horizontal line wider than the bbox
    const horizontalLine = turf.lineString([
      [minX - 0.1, y],
      [maxX + 0.1, y]
    ]);
    
    try {
      const split = turf.lineSplit(horizontalLine, rotatedPoly);
      
      if (split.features.length > 0) {
        split.features.forEach(segment => {
          const coords = segment.geometry.coordinates;
          const midPoint = turf.midpoint(coords[0], coords[1]);
          
          if (turf.booleanPointInPolygon(midPoint, rotatedPoly)) {
            let finalCoords = coords;

            // 4. Extend lines if requested
            if (extensionMeters > 0) {
              const lineLen = turf.distance(coords[0], coords[1], { units: 'kilometers' }) * 1000;
              const bearing = turf.bearing(coords[0], coords[1]);
              
              // Extend start
              const newStart = turf.destination(coords[0], extensionMeters / 1000, bearing + 180, { units: 'kilometers' });
              // Extend end
              const newEnd = turf.destination(coords[1], extensionMeters / 1000, bearing, { units: 'kilometers' });
              
              finalCoords = [newStart.geometry.coordinates, newEnd.geometry.coordinates];
            }

            // 5. Rotate the segment back
            const segmentFeature = turf.lineString(finalCoords);
            const finalSegment = turf.transformRotate(segmentFeature, angleDegrees, { pivot });
            
            finalSegment.id = `line-${angleDegrees}-${y.toFixed(10)}-${lines.length}`;
            lines.push(finalSegment as Feature<LineString>);
          }
        });
      }
    } catch (e) {
      console.error("Error generating line segment:", e);
    }
  }

  return turf.featureCollection(lines);
}

// --- Components ---

const Logo = ({ className = "", grayscale = false, light = false }: { className?: string, grayscale?: boolean, light?: boolean }) => (
  <div className={cn("flex items-center gap-3", className, grayscale && "grayscale opacity-50")}>
    <img 
      src={austaThaiLogo} 
      alt="Austhai Logo" 
      className="w-10 h-10 object-contain rounded-xl shadow-lg shadow-blue-600/10 shrink-0 border border-slate-100 p-1 bg-white" 
    />
  </div>
);

function MapController({ bounds, onMapClick, setMapInstance }: { bounds: BBox | null, onMapClick?: (e: any) => void, setMapInstance?: (map: L.Map) => void }) {
  const map = useMap();
  
  useEffect(() => {
    if (setMapInstance) setMapInstance(map);
  }, [map, setMapInstance]);
  
  useEffect(() => {
    if (bounds) {
      map.fitBounds([
        [bounds[1], bounds[0]],
        [bounds[3], bounds[2]]
      ], { padding: [50, 50] });
    }
  }, [bounds, map]);

  useEffect(() => {
    if (onMapClick) {
      map.on('click', onMapClick);
      return () => { map.off('click', onMapClick); };
    }
  }, [map, onMapClick]);

  return null;
}

export default function App() {
  const [geoJson, setGeoJson] = useState<FeatureCollection | null>(null);
  const [settings, setSettings] = useState<PlanningSettings>({
    flightLineSpacing: 25,
    tieLineSpacing: 100,
    angle: 0,
    overlap: 70,
    flightLineColor: '#2563eb', // blue-600
    tieLineColor: '#64748b',    // slate-500
    boundaryColor: '#0f172a',   // slate-900
    swapDirections: false,
    lineExtension: 0,
    gridOffsetX: 0,
    gridOffsetY: 0
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [exportFormat, setExportFormat] = useState<'geojson' | 'kml' | 'kmz' | 'csv'>('geojson');
  
  // Manual Editing State
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [deletedLineIds, setDeletedLineIds] = useState<Set<string>>(new Set());
  const [modifiedLines, setModifiedLines] = useState<Record<string, Feature<LineString>>>({});
  const [isEditMode, setIsEditMode] = useState(false);
  const [manualEditCounter, setManualEditCounter] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [basemap, setBasemap] = useState<'osm' | 'satellite' | 'offline'>('osm');
  const [offlineMode, setOfflineMode] = useState(false);
  const [localTileServerUrl, setLocalTileServerUrl] = useState('http://localhost:8080');
  const [useLocalTiles, setUseLocalTiles] = useState(false);
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const [showFlightLines, setShowFlightLines] = useState(true);
  const [showTieLines, setShowTieLines] = useState(true);
  const [areaUnit, setAreaUnit] = useState<'m2' | 'km2' | 'hectare'>('km2');
  const [elevationProfile, setElevationProfile] = useState<{distance: number, elevation: number}[] | null>(null);
  const [isFetchingElevation, setIsFetchingElevation] = useState(false);

  const fetchElevationProfile = async (line: Feature<LineString>) => {
    setIsFetchingElevation(true);
    try {
      const coords = line.geometry.coordinates;
      const lineString = turf.lineString(coords);
      const length = turf.length(lineString, { units: 'meters' });
      const points = [];
      const numSamples = 20;

      for (let i = 0; i <= numSamples; i++) {
        const dist = (length / numSamples) * i;
        const point = turf.along(lineString, dist, { units: 'meters' });
        points.push({
          latitude: point.geometry.coordinates[1],
          longitude: point.geometry.coordinates[0],
          distance: Math.round(dist)
        });
      }

      // Fetch from Open-Elevation
      const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: points.map(p => ({ latitude: p.latitude, longitude: p.longitude })) })
      });
      
      if (res.ok) {
        const data = await res.json();
        const profile = data.results.map((r: any, idx: number) => ({
          distance: points[idx].distance,
          elevation: r.elevation
        }));
        setElevationProfile(profile);
      } else {
        // Fallback: Simulated elevation for demo
        const profile = points.map((p, idx) => ({
          distance: p.distance,
          elevation: 100 + Math.sin(idx / 2) * 50 + Math.random() * 10
        }));
        setElevationProfile(profile);
      }
    } catch (error) {
      console.error("Elevation fetch failed:", error);
    } finally {
      setIsFetchingElevation(false);
    }
  };

  useEffect(() => {
    if (selectedLineId) {
      const line = [...(flightLines?.features || []), ...(tieLines?.features || [])].find(f => f.id === selectedLineId);
      if (line) fetchElevationProfile(line as Feature<LineString>);
    } else {
      setElevationProfile(null);
    }
  }, [selectedLineId]);

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      setInstallPrompt(null);
    }
  };

  // Reset manual edits when settings change
  useEffect(() => {
    setDeletedLineIds(new Set());
    setModifiedLines({});
    setSelectedLineId(null);
    setManualEditCounter(0);
  }, [settings.flightLineSpacing, settings.tieLineSpacing, settings.angle, settings.swapDirections]);

  // Derived data
  const mainPolygon = useMemo(() => {
    if (!geoJson) return null;
    const polys = geoJson.features.filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
    return polys.length > 0 ? (polys[0] as Feature<Polygon | MultiPolygon>) : null;
  }, [geoJson]);

  const flightLines = useMemo(() => {
    if (!mainPolygon) return null;
    const angle = settings.swapDirections ? settings.angle + 90 : settings.angle;
    const generated = generateLines(
      mainPolygon, 
      settings.flightLineSpacing, 
      angle, 
      settings.lineExtension,
      settings.gridOffsetY
    );
    
    // Apply manual edits
    const filtered = generated.features.filter(f => !deletedLineIds.has(f.id as string));
    const finalFeatures = filtered.map(f => modifiedLines[f.id as string] || f);
    
    return turf.featureCollection(finalFeatures);
  }, [mainPolygon, settings.flightLineSpacing, settings.angle, settings.swapDirections, deletedLineIds, modifiedLines]);

  const tieLines = useMemo(() => {
    if (!mainPolygon || settings.tieLineSpacing <= 0) return null;
    const angle = settings.swapDirections ? settings.angle : settings.angle + 90;
    const generated = generateLines(
      mainPolygon, 
      settings.tieLineSpacing, 
      angle, 
      settings.lineExtension,
      settings.gridOffsetX
    );
    
    // Apply manual edits
    const filtered = generated.features.filter(f => !deletedLineIds.has(f.id as string));
    const finalFeatures = filtered.map(f => modifiedLines[f.id as string] || f);
    
    return turf.featureCollection(finalFeatures);
  }, [mainPolygon, settings.tieLineSpacing, settings.angle, settings.swapDirections, deletedLineIds, modifiedLines]);

  const bbox = useMemo(() => {
    if (!mainPolygon) return null;
    return turf.bbox(mainPolygon);
  }, [mainPolygon]);

  const stats = useMemo(() => {
    if (!flightLines || !tieLines) return null;
    const fLength = turf.length(flightLines, { units: 'kilometers' });
    const tLength = turf.length(tieLines, { units: 'kilometers' });
    const area = mainPolygon ? turf.area(mainPolygon) / 1000000 : 0; // km2
    return {
      flightLength: fLength.toFixed(2),
      tieLength: tLength.toFixed(2),
      totalLength: (fLength + tLength).toFixed(2),
      area: area.toFixed(3)
    };
  }, [flightLines, tieLines, mainPolygon]);

  // Calculate area of interest
  const areaStats = useMemo(() => {
    if (!mainPolygon) return null;
    const areaInMeters = turf.area(mainPolygon);
    const areaSqKm = areaInMeters / 1e6;
    const areaHectare = areaInMeters / 10000;
    return {
      m2: areaInMeters.toFixed(2),
      km2: areaSqKm.toFixed(4),
      hectare: areaHectare.toFixed(2)
    };
  }, [mainPolygon]);

  // Handlers
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setFileName(file.name);
    const extension = file.name.split('.').pop()?.toLowerCase();

    try {
      const buffer = await file.arrayBuffer();
      let data: any = null;

      console.log(`Processing file: ${file.name} (${buffer.byteLength} bytes) extension: ${extension}`);

      if (extension === 'kml') {
        const text = new TextDecoder().decode(buffer);
        const dom = new DOMParser().parseFromString(text, 'text/xml');
        data = kml(dom);
      } else if (extension === 'kmz') {
        const zip = await JSZip.loadAsync(buffer);
        const kmlFile = Object.keys(zip.files).find(name => name.endsWith('.kml'));
        if (!kmlFile) throw new Error("No KML file found inside KMZ");
        const kmlText = await zip.files[kmlFile].async('string');
        const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
        data = kml(dom);
      } else if (extension === 'json' || extension === 'geojson') {
        const text = new TextDecoder().decode(buffer);
        data = JSON.parse(text);
      } else {
        // Assume shapefile zip for other extensions or .zip
        try {
          data = await shp(buffer);
        } catch (err: any) {
          if (extension !== 'zip') {
            throw new Error(`Unsupported file format: .${extension}. Please use .zip (Shapefile), .kml, .kmz, or .geojson`);
          }
          throw err;
        }
      }

      if (!data) {
        throw new Error("No data returned from file parser.");
      }

      // Standardize the output to a FeatureCollection
      if (Array.isArray(data)) {
        // Find the first feature collection with polygons
        const collectionWithPolygons = data.find(item => 
          item.type === 'FeatureCollection' && 
          item.features.some((f: any) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
        );
        setGeoJson((collectionWithPolygons || data[0]) as any);
      } else if (data.type === 'FeatureCollection') {
        setGeoJson(data as any);
      } else if (data.type === 'Feature') {
        setGeoJson(turf.featureCollection([data]) as any);
      } else {
        // Handle cases where shpjs or togeojson might return something else
        setGeoJson(data as any);
      }
    } catch (err: any) {
      console.error("File processing error:", err);
      const errorMessage = err?.message || String(err);
      const isZipError = errorMessage.toLowerCase().includes('unzip') || errorMessage.toLowerCase().includes('zip');
      
      alert(
        `File processing error: ${errorMessage}\n\n` +
        (isZipError 
          ? "Tip: This usually means the .zip or .kmz file is invalid or corrupted."
          : "Tip: Ensure you are uploading a valid .kml, .kmz, .geojson, or shapefile .zip archive.")
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const latLngToUTM = (lat: number, lng: number) => {
    const WGS84_A = 6378137.0;
    const WGS84_E2 = 0.00669438;
    
    const utmZone = Math.floor((lng + 180) / 6) + 1;
    const lon0 = (utmZone - 1) * 6 - 180 + 3;
    const lon0Rad = lon0 * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const lngRad = lng * Math.PI / 180;
    
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(latRad) * Math.sin(latRad));
    const T = Math.tan(latRad) * Math.tan(latRad);
    const C = WGS84_E2 / (1 - WGS84_E2) * Math.cos(latRad) * Math.cos(latRad);
    const A = Math.cos(latRad) * ((lngRad - lon0Rad) % (2 * Math.PI));
    const M = WGS84_A * ((1 - WGS84_E2 / 4 - 3 * WGS84_E2 * WGS84_E2 / 64) * latRad - 
             (3 * WGS84_E2 / 8 + 3 * WGS84_E2 * WGS84_E2 / 64) * Math.sin(2 * latRad) +
             (15 * WGS84_E2 * WGS84_E2 / 256) * Math.sin(4 * latRad));
    
    const easting = 500000 + 0.9996 * N * (A + A * A * A / 6 * (1 - T + C));
    const northing = 0.9996 * (M + N * Math.tan(latRad) * (A * A / 2 + A * A * A * A / 24 * (5 - T + 9 * C + 4 * C * C)));
    
    return { easting: Math.round(easting), northing: Math.round(northing) };
  };

  const generateSummaryCSV = () => {
    if (!flightLines || !tieLines || !stats) return '';
    const baseName = fileName ? fileName.split('.')[0] : 'drone-plan';
    const timestamp = new Date().toISOString().split('T')[0];
    
    let csv = '';
    csv += '"LINE PLAN SUMMARY"\n';
    csv += '"Generated Date","' + timestamp + '"\n';
    csv += '"Project Name","' + baseName + '"\n';
    csv += '\n';
    
    csv += '"MISSION SETTINGS"\n';
    csv += '"Flight Line Spacing (m)","' + settings.flightLineSpacing + '"\n';
    csv += '"Tie Line Spacing (m)","' + settings.tieLineSpacing + '"\n';
    csv += '"Flight Direction (deg)","' + settings.angle + '"\n';
    csv += '"Overlap (%)","' + settings.overlap + '"\n';
    csv += '"Line Extension (m)","' + settings.lineExtension + '"\n';
    csv += '"Swap Directions","' + (settings.swapDirections ? 'Yes' : 'No') + '"\n';
    csv += '"Grid Offset X (m)","' + settings.gridOffsetX + '"\n';
    csv += '"Grid Offset Y (m)","' + settings.gridOffsetY + '"\n';
    csv += '\n';
    
    csv += '"MISSION STATISTICS"\n';
    csv += '"Flight Lines","' + flightLines.features.length + '"\n';
    csv += '"Tie Lines","' + tieLines.features.length + '"\n';
    csv += '"Total Lines","' + (flightLines.features.length + tieLines.features.length) + '"\n';
    csv += '"Flight Line Distance (km)","' + stats.flightLength + '"\n';
    csv += '"Tie Line Distance (km)","' + stats.tieLength + '"\n';
    csv += '"Total Path Length (km)","' + stats.totalLength + '"\n';
    csv += '"Coverage Area (km²)","' + stats.area + '"\n';
    if (areaStats) {
      csv += '"Coverage Area (m²)","' + areaStats.m2 + '"\n';
      csv += '"Coverage Area (hectares)","' + areaStats.hectare + '"\n';
    }
    
    return csv;
  };

  const generateLineDetailsCSV = () => {
    if (!flightLines || !tieLines) return '';
    
    let csv = '';
    csv += '"Line ID","Type","Length (km)","START","","END",""\n';
    csv += '"","","","Easting","Northing","Easting","Northing"\n';
    
    flightLines.features.forEach((feature, idx) => {
      const coords = feature.geometry.coordinates;
      const lineLength = turf.length(feature, { units: 'kilometers' });
      const startLat = coords[0][1];
      const startLng = coords[0][0];
      const endLat = coords[coords.length - 1][1];
      const endLng = coords[coords.length - 1][0];
      
      const startUTM = latLngToUTM(startLat, startLng);
      const endUTM = latLngToUTM(endLat, endLng);
      
      csv += `"FL-${idx + 1}","Flight Line","${lineLength.toFixed(4)}","${startUTM.easting}","${startUTM.northing}","${endUTM.easting}","${endUTM.northing}"\n`;
    });
    
    tieLines.features.forEach((feature, idx) => {
      const coords = feature.geometry.coordinates;
      const lineLength = turf.length(feature, { units: 'kilometers' });
      const startLat = coords[0][1];
      const startLng = coords[0][0];
      const endLat = coords[coords.length - 1][1];
      const endLng = coords[coords.length - 1][0];
      
      const startUTM = latLngToUTM(startLat, startLng);
      const endUTM = latLngToUTM(endLat, endLng);
      
      csv += `"TL-${idx + 1}","Tie Line","${lineLength.toFixed(4)}","${startUTM.easting}","${startUTM.northing}","${endUTM.easting}","${endUTM.northing}"\n`;
    });
    
    return csv;
  };

  const handleExport = async () => {
    if (!flightLines || !tieLines) return;
    const baseName = fileName ? fileName.split('.')[0] : 'drone-plan';
    
    if (exportFormat === 'csv') {
      // Generate both CSV files and zip them together
      const summaryCSV = generateSummaryCSV();
      const lineDetailsCSV = generateLineDetailsCSV();
      
      const zip = new JSZip();
      zip.file(`${baseName}-summary.csv`, summaryCSV);
      zip.file(`${baseName}-line-details.csv`, lineDetailsCSV);
      
      const content = await zip.generateAsync({ type: "blob" });
      downloadBlob(content, `${baseName}-plan.zip`);
    } else {
      const combined = getCombinedGeoJSON();
      
      if (exportFormat === 'geojson') {
        const blob = new Blob([JSON.stringify(combined)], { type: 'application/json' });
        downloadBlob(blob, `${baseName}-plan.geojson`);
      } else if (exportFormat === 'kml') {
        const kmlContent = tokml(combined);
        const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml' });
        downloadBlob(blob, `${baseName}-plan.kml`);
      } else if (exportFormat === 'kmz') {
        const kmlContent = tokml(combined);
        const zip = new JSZip();
        zip.file("doc.kml", kmlContent);
        const content = await zip.generateAsync({ type: "blob" });
        downloadBlob(content, `${baseName}-plan.kmz`);
      }
    }
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getCombinedGeoJSON = () => {
    if (!flightLines || !tieLines) return turf.featureCollection([]);
    const features = [
      ...flightLines.features.map((f) => ({ 
        ...f, 
        properties: { 
          type: 'flight-line',
          name: 'Flight Line',
          stroke: settings.flightLineColor,
          'stroke-width': 3,
          'stroke-opacity': 1
        } 
      })),
      ...tieLines.features.map((f) => ({ 
        ...f, 
        properties: { 
          type: 'tie-line',
          name: 'Tie Line',
          stroke: settings.tieLineColor,
          'stroke-width': 1.5,
          'stroke-opacity': 0.8,
          'stroke-dasharray': '4, 4'
        } 
      }))
    ];
    // Add boundary if available (with no fill or stroke so it's transparent)
    if (mainPolygon) {
      features.push({ ...mainPolygon, properties: { type: 'boundary', 'fill-opacity': 0, 'stroke-opacity': 0 } });
    }
    return turf.featureCollection(features);
  };

  const combinedGeoJSON = useMemo(() => getCombinedGeoJSON(), [flightLines, tieLines, mainPolygon, settings]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white text-slate-900">
      {/* Preview Modal */}
      <AnimatePresence>
        {showPreview && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPreview(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <Logo />
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 tracking-tight">Mission Preview</h2>
                    <p className="text-xs text-slate-400 font-mono uppercase tracking-widest">{fileName || 'Untitled Mission'}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowPreview(false)}
                  className="p-2 hover:bg-slate-50 rounded-full text-slate-400 hover:text-slate-900 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-8 space-y-8">
                <div className="grid grid-cols-3 gap-6">
                  <div className="space-y-1">
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Total Distance</p>
                    <p className="text-2xl font-bold text-blue-600 font-mono">{stats?.totalLength} <span className="text-xs opacity-50">km</span></p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Flight Lines</p>
                    <p className="text-2xl font-bold text-slate-900 font-mono">{flightLines?.features.length}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Tie Lines</p>
                    <p className="text-2xl font-bold text-slate-900 font-mono">{tieLines?.features.length}</p>
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">GeoJSON Structure Preview</label>
                  <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100 font-mono text-[11px] text-blue-600/60 overflow-hidden relative group">
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent to-white/80 pointer-events-none" />
                    <pre className="max-h-48 overflow-hidden">
                      {JSON.stringify(combinedGeoJSON, null, 2)}
                    </pre>
                  </div>
                </div>

                <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100 space-y-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Coordinate System</span>
                    <span className="text-slate-900 font-mono">WGS84 (EPSG:4326)</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Feature Count</span>
                    <span className="text-slate-900 font-mono">{(flightLines?.features.length || 0) + (tieLines?.features.length || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Survey Area</span>
                    <span className="text-slate-900 font-mono">{stats?.area} km²</span>
                  </div>
                </div>
              </div>

              <div className="p-8 border-t border-slate-100 bg-slate-50 flex gap-4">
                <button 
                  onClick={() => setShowPreview(false)}
                  className="flex-1 px-6 py-4 rounded-2xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-100 transition-all"
                >
                  Close Preview
                </button>
                <button 
                  onClick={() => {
                    handleExport();
                    setShowPreview(false);
                  }}
                  className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-600/10"
                >
                  <Download className="w-4 h-4" />
                  Confirm & Download
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Sidebar */}
      <aside className="w-80 bg-white text-slate-900 flex flex-col border-r border-slate-200 z-20">
        <div className="p-6 border-b border-slate-100 flex flex-col gap-4">
          <Logo className="mb-2" />
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">Austhai UAV <span className="italic font-serif opacity-50 text-sm">Line planner</span></h1>
            </div>
            <p className="text-[9px] text-slate-400 font-medium -mt-1 mb-2">created by Ray Emmanuel B. Diaz</p>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Mission Control v1.0</p>
          </div>
          {installPrompt ? (
            <button 
              onClick={handleInstall}
              className="mt-2 w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-600/20"
            >
              <Monitor className="w-3 h-3" />
              Install Desktop App
            </button>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-hide">
          {/* Info Section */}
          <section className="bg-blue-50 border border-blue-100 rounded-xl p-4">
            <div className="flex gap-3">
              <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <p className="text-[11px] text-blue-600/80 leading-relaxed">
                Supports <span className="font-bold text-blue-600">KML, KMZ, GeoJSON</span> and <span className="font-bold text-blue-600">Zipped Shapefiles</span> (.shp, .shx, .dbf).
              </p>
            </div>
          </section>

          {/* Upload Section */}
          <section>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-3 font-mono">1. Area of Interest</label>
            {!geoJson ? (
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-200 rounded-xl cursor-pointer hover:border-blue-400/50 hover:bg-slate-50 transition-all group">
                <Upload className="w-8 h-8 text-slate-300 group-hover:text-blue-600 transition-colors mb-2" />
                <span className="text-xs text-slate-400 group-hover:text-slate-600 text-center px-4">Upload KML, KMZ, GeoJSON or Shapefile (.zip)</span>
                <input type="file" className="hidden" accept=".zip,.kml,.kmz,.json,.geojson" onChange={handleFileUpload} />
              </label>
            ) : (
              <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                    <MapIcon className="w-4 h-4 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-900">Area Loaded</p>
                    <p className="text-[10px] text-slate-400 font-mono">{stats?.area} km²</p>
                  </div>
                </div>
                <button 
                  onClick={() => setGeoJson(null)}
                  className="p-2 hover:bg-red-50 rounded-lg text-slate-300 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </section>

          {/* Settings Section */}
          <section className={cn("space-y-4 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-3 font-mono">2. Path Parameters</label>
            
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-xs text-slate-600">Flight Line Spacing (m)</label>
                  <input 
                    type="number"
                    value={settings.flightLineSpacing}
                    onChange={(e) => setSettings(s => ({ ...s, flightLineSpacing: Number(e.target.value) }))}
                    className="w-16 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-xs font-mono text-blue-600 text-right focus:border-blue-500/50 outline-none"
                  />
                </div>
                <input 
                  type="range" min="1" max="500" step="1"
                  value={settings.flightLineSpacing}
                  onChange={(e) => setSettings(s => ({ ...s, flightLineSpacing: Number(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-xs text-slate-600">Tie Line Spacing (m)</label>
                  <input 
                    type="number"
                    value={settings.tieLineSpacing}
                    onChange={(e) => setSettings(s => ({ ...s, tieLineSpacing: Number(e.target.value) }))}
                    className="w-16 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-xs font-mono text-blue-600 text-right focus:border-blue-500/50 outline-none"
                  />
                </div>
                <input 
                  type="range" min="0" max="1000" step="1"
                  value={settings.tieLineSpacing}
                  onChange={(e) => setSettings(s => ({ ...s, tieLineSpacing: Number(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-xs text-slate-600">Orientation Angle (°)</label>
                  <input 
                    type="number"
                    value={settings.angle}
                    onChange={(e) => setSettings(s => ({ ...s, angle: Number(e.target.value) }))}
                    className="w-16 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-xs font-mono text-blue-600 text-right focus:border-blue-500/50 outline-none"
                  />
                </div>
                <div className="flex gap-3 items-center">
                  <input 
                    type="range" min="0" max="360" step="1"
                    value={settings.angle}
                    onChange={(e) => setSettings(s => ({ ...s, angle: Number(e.target.value) }))}
                    className="flex-1 h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <button 
                    onClick={() => setSettings(s => ({ ...s, swapDirections: !s.swapDirections }))}
                    title="Swap Flight/Tie Directions"
                    className={cn(
                      "p-2 rounded-lg border transition-all",
                      settings.swapDirections 
                        ? "bg-blue-500/20 border-blue-500/40 text-blue-600" 
                        : "bg-slate-50 border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-slate-100"
                    )}
                  >
                    <ArrowLeftRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-100">
                <div className="flex justify-between mb-2">
                  <label className="text-xs text-slate-600">Line Extension (m)</label>
                  <input 
                    type="number"
                    value={settings.lineExtension}
                    onChange={(e) => setSettings(s => ({ ...s, lineExtension: Number(e.target.value) }))}
                    className="w-16 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-xs font-mono text-blue-600 text-right focus:border-blue-500/50 outline-none"
                  />
                </div>
                <input 
                  type="range" min="0" max="100" step="1"
                  value={settings.lineExtension}
                  onChange={(e) => setSettings(s => ({ ...s, lineExtension: Number(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1 uppercase font-mono">Grid Offset X (m)</label>
                  <input 
                    type="number"
                    value={settings.gridOffsetX}
                    onChange={(e) => setSettings(s => ({ ...s, gridOffsetX: Number(e.target.value) }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono text-blue-600 focus:border-blue-500/50 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1 uppercase font-mono">Grid Offset Y (m)</label>
                  <input 
                    type="number"
                    value={settings.gridOffsetY}
                    onChange={(e) => setSettings(s => ({ ...s, gridOffsetY: Number(e.target.value) }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono text-blue-600 focus:border-blue-500/50 outline-none"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Offline & Map Settings */}
          <section className="space-y-4">
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-3 font-mono">Offline & Map</label>
            
            <div className="space-y-3">
              <div className="p-3 bg-amber-50/50 border border-amber-100/50 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-slate-600 font-medium">Offline Mode</label>
                  <button
                    onClick={() => setOfflineMode(!offlineMode)}
                    className={cn(
                      "px-2 py-1 rounded text-[9px] font-bold transition-all",
                      offlineMode
                        ? "bg-amber-600 text-white"
                        : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                    )}
                  >
                    {offlineMode ? "ON" : "OFF"}
                  </button>
                </div>
                <p className="text-[9px] text-slate-500">When enabled, uses cached tiles and disables API calls</p>
              </div>

              <div className="p-3 bg-blue-50/50 border border-blue-100/50 rounded-lg">
                <label className="block text-xs text-slate-600 mb-2 font-medium">Local Tile Server URL</label>
                <input
                  type="text"
                  value={localTileServerUrl}
                  onChange={(e) => setLocalTileServerUrl(e.target.value)}
                  placeholder="http://localhost:8080"
                  className="w-full bg-white border border-blue-200 rounded px-2 py-1 text-xs font-mono text-slate-900 focus:border-blue-500/50 outline-none"
                />
                <p className="text-[9px] text-slate-500 mt-1">For offline tile server (e.g., TileServer GL)</p>
                <label className="flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    checked={useLocalTiles}
                    onChange={(e) => setUseLocalTiles(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-[9px] text-slate-600">Use local tile server</span>
                </label>
              </div>
            </div>
          </section>

          {/* Line Visibility Section */}
          <section className={cn("space-y-3 pt-4 border-t border-slate-100 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono">3a. Layer Visibility</label>
            
            <div className="space-y-2">
              <label className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50 transition-colors">
                <input 
                  type="checkbox" 
                  checked={showFlightLines}
                  onChange={(e) => setShowFlightLines(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 cursor-pointer"
                />
                <span className="text-xs text-slate-600 flex-1">Show Flight Lines</span>
                <div className="w-4 h-1 rounded-full" style={{ backgroundColor: settings.flightLineColor }} />
              </label>
              <label className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50 transition-colors">
                <input 
                  type="checkbox" 
                  checked={showTieLines}
                  onChange={(e) => setShowTieLines(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 cursor-pointer"
                />
                <span className="text-xs text-slate-600 flex-1">Show Tie Lines</span>
                <div className="w-4 h-1 rounded-full" style={{ backgroundColor: settings.tieLineColor }} />
              </label>
            </div>
          </section>

          {/* Area Measurement Section */}
          <section className={cn("space-y-3 pt-4 border-t border-slate-100 transition-opacity", !mainPolygon && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono">3b. Area of Interest</label>
            
            {areaStats && (
              <div className="space-y-2">
                <div className="bg-slate-50 rounded-lg p-2 border border-slate-100">
                  <p className="text-[9px] text-slate-400 uppercase mb-1">Coverage Area</p>
                  <div className="space-y-1">
                    <p className="text-xs font-mono text-slate-900">{areaStats.m2} <span className="text-[8px] opacity-50">m²</span></p>
                    <p className="text-xs font-mono text-slate-900">{areaStats.km2} <span className="text-[8px] opacity-50">km²</span></p>
                    <p className="text-xs font-mono text-slate-900">{areaStats.hectare} <span className="text-[8px] opacity-50">hectare</span></p>
                  </div>
                </div>
              </div>
            )}
            {!mainPolygon && (
              <p className="text-[10px] text-slate-400 italic">Upload a file to calculate area</p>
            )}
          </section>

          {/* Style Section */}
          <section className={cn("space-y-4 pt-4 border-t border-slate-100 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-3 font-mono">4. Style Configuration</label>
            
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-600">Flight Lines</label>
                <input 
                  type="color" 
                  value={settings.flightLineColor}
                  onChange={(e) => setSettings(s => ({ ...s, flightLineColor: e.target.value }))}
                  className="w-8 h-8 rounded-lg bg-transparent border-none cursor-pointer"
                />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-600">Tie Lines</label>
                <input 
                  type="color" 
                  value={settings.tieLineColor}
                  onChange={(e) => setSettings(s => ({ ...s, tieLineColor: e.target.value }))}
                  className="w-8 h-8 rounded-lg bg-transparent border-none cursor-pointer"
                />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-600">Boundary</label>
                <input 
                  type="color" 
                  value={settings.boundaryColor}
                  onChange={(e) => setSettings(s => ({ ...s, boundaryColor: e.target.value }))}
                  className="w-8 h-8 rounded-lg bg-transparent border-none cursor-pointer"
                />
              </div>
            </div>
          </section>

          {/* Edit Mode Section */}
          <section className={cn("space-y-4 pt-4 border-t border-slate-100 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-widest text-slate-400 font-mono">5. Manual Editing</label>
              <button 
                onClick={() => {
                  setIsEditMode(!isEditMode);
                  if (isEditMode) setSelectedLineId(null);
                }}
                className={cn(
                  "px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider transition-all border",
                  isEditMode 
                    ? "bg-blue-600 border-blue-600 text-white" 
                    : "bg-slate-50 border-slate-200 text-slate-400 hover:text-slate-900"
                )}
              >
                {isEditMode ? 'Editing On' : 'Edit Mode'}
              </button>
            </div>

            {isEditMode && (
              <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-4">
                  {!selectedLineId ? (
                    <p className="text-[10px] text-slate-400 text-center italic">Click a line on the map to select it</p>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-blue-600 font-mono uppercase">Line Selected</span>
                        <button 
                          onClick={() => {
                            setDeletedLineIds(prev => new Set([...prev, selectedLineId]));
                            setSelectedLineId(null);
                            setManualEditCounter(c => c + 1);
                          }}
                          className="p-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-lg transition-all"
                          title="Delete Line"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-[9px] text-slate-400 leading-relaxed">
                        Drag the white handles on the map to adjust endpoints.
                      </p>
                    </div>
                  )}
                  
                  <button 
                    onClick={() => {
                      setDeletedLineIds(new Set());
                      setModifiedLines({});
                      setSelectedLineId(null);
                      setManualEditCounter(0);
                    }}
                    disabled={deletedLineIds.size === 0 && Object.keys(modifiedLines).length === 0}
                    className={cn(
                      "w-full py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg border flex items-center justify-center gap-2 transition-all",
                      (deletedLineIds.size > 0 || Object.keys(modifiedLines).length > 0)
                        ? "bg-slate-50 hover:bg-slate-100 text-slate-600 hover:text-slate-900 border-slate-200"
                        : "bg-slate-50 text-slate-200 border-slate-100 cursor-not-allowed"
                    )}
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset All Edits
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Stats Section */}
          {stats && (
            <section className="pt-4 border-t border-slate-100">
              <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-4 font-mono">6. Mission Statistics</label>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                  <p className="text-[10px] text-slate-400 uppercase mb-1">Flight Dist</p>
                  <p className="text-sm font-mono text-slate-900">{stats.flightLength} <span className="text-[10px] opacity-50">km</span></p>
                </div>
                <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                  <p className="text-[10px] text-slate-400 uppercase mb-1">Tie Dist</p>
                  <p className="text-sm font-mono text-slate-900">{stats.tieLength} <span className="text-[10px] opacity-50">km</span></p>
                </div>
                <div className="col-span-2 bg-blue-50 rounded-xl p-3 border border-blue-100">
                  <p className="text-[10px] text-blue-600/60 uppercase mb-1">Total Path Length</p>
                  <p className="text-lg font-mono text-blue-600">{stats.totalLength} <span className="text-xs opacity-50">km</span></p>
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="p-6 border-t border-slate-100 bg-slate-50 space-y-3">
          <button 
            disabled={!geoJson}
            onClick={() => setShowPreview(true)}
            className="w-full bg-white hover:bg-slate-50 disabled:opacity-20 text-slate-600 font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all border border-slate-200"
          >
            <Eye className="w-4 h-4" />
            Preview Mission
          </button>
          <div className="space-y-3">
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono">Export Format</label>
            <div className="grid grid-cols-4 gap-2">
              {(['csv', 'geojson', 'kml', 'kmz'] as const).map((format) => (
                <button
                  key={format}
                  onClick={() => setExportFormat(format)}
                  className={cn(
                    "py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border",
                    exportFormat === format 
                      ? "bg-blue-600 border-blue-600 text-white" 
                      : "bg-white border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-slate-50"
                  )}
                >
                  {format}
                </button>
              ))}
            </div>
          </div>

          <button 
            disabled={!geoJson}
            onClick={handleExport}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-100 disabled:text-slate-300 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-blue-600/10"
          >
            <Download className="w-4 h-4" />
            Generate & Export
          </button>
          <p className="text-[9px] text-center text-slate-400 mt-4 uppercase tracking-tighter">
            Exported as {exportFormat === 'csv' ? 'ZIP (2 CSV files - Summary & Line Details)' : exportFormat.toUpperCase() + ' (WGS84)'}
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 relative bg-slate-50">
        {isProcessing && (
          <div className="absolute inset-0 z-[1000] bg-white/40 backdrop-blur-sm flex items-center justify-center">
            <div className="bg-white text-slate-900 px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 border border-slate-200">
              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium">Processing Geometry...</p>
            </div>
          </div>
        )}

        <MapContainer 
          center={[0, 0]} 
          zoom={2} 
          className="h-full w-full"
        >
          {offlineMode || basemap === 'osm' ? (
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          ) : (
            <TileLayer
              attribution='&copy; Google'
              url="https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
            />
          )}
          
          {geoJson && (
            <GeoJSON 
              data={geoJson} 
              style={{
                color: settings.boundaryColor,
                weight: 2,
                fillColor: settings.boundaryColor,
                fillOpacity: 0.1,
                dashArray: '5, 5'
              }}
            />
          )}

          {flightLines && showFlightLines && (
            <GeoJSON 
              key={`flight-${settings.flightLineSpacing}-${settings.angle}-${settings.flightLineColor}-${manualEditCounter}`}
              data={flightLines} 
              style={(feature) => ({
                color: selectedLineId === feature?.id ? '#ffffff' : settings.flightLineColor,
                weight: selectedLineId === feature?.id ? 4 : 2,
                opacity: 0.8,
                cursor: isEditMode ? 'pointer' : 'default'
              })}
              eventHandlers={{
                click: (e) => {
                  if (isEditMode) {
                    const feature = e.propagatedFrom.feature;
                    setSelectedLineId(feature.id);
                    L.DomEvent.stopPropagation(e);
                  }
                }
              }}
            />
          )}

          {tieLines && showTieLines && (
            <GeoJSON 
              key={`tie-${settings.tieLineSpacing}-${settings.angle}-${settings.tieLineColor}-${manualEditCounter}`}
              data={tieLines} 
              style={(feature) => ({
                color: selectedLineId === feature?.id ? '#ffffff' : settings.tieLineColor,
                weight: selectedLineId === feature?.id ? 3 : 1.5,
                opacity: 0.6,
                dashArray: '4, 4',
                cursor: isEditMode ? 'pointer' : 'default'
              })}
              eventHandlers={{
                click: (e) => {
                  if (isEditMode) {
                    const feature = e.propagatedFrom.feature;
                    setSelectedLineId(feature.id);
                    L.DomEvent.stopPropagation(e);
                  }
                }
              }}
            />
          )}

          {/* Edit Handles */}
          {isEditMode && selectedLineId && (
            <>
              {[flightLines, tieLines].map(collection => {
                const feature = collection?.features.find(f => f.id === selectedLineId);
                if (!feature) return null;
                
                const coords = feature.geometry.coordinates;
                return coords.map((coord, idx) => (
                  <Marker
                    key={`handle-${selectedLineId}-${idx}`}
                    position={[coord[1], coord[0]]}
                    draggable={true}
                    icon={L.divIcon({
                      className: 'bg-white border-2 border-blue-600 rounded-full w-3 h-3 shadow-lg',
                      iconSize: [12, 12],
                      iconAnchor: [6, 6]
                    })}
                    eventHandlers={{
                      drag: (e) => {
                        const newPos = e.target.getLatLng();
                        const newCoords = [...coords];
                        newCoords[idx] = [newPos.lng, newPos.lat];
                        
                        const newFeature = {
                          ...feature,
                          geometry: {
                            ...feature.geometry,
                            coordinates: newCoords
                          }
                        };
                        
                        setModifiedLines(prev => ({
                          ...prev,
                          [selectedLineId]: newFeature
                        }));
                        setManualEditCounter(c => c + 1);
                      }
                    }}
                  />
                ));
              })}
            </>
          )}

          <MapController 
            bounds={bbox} 
            setMapInstance={setMapInstance}
            onMapClick={(e: any) => {
              if (isEditMode) setSelectedLineId(null);
            }}
          />
        </MapContainer>

        {/* Floating UI Elements */}
        <div className="absolute top-6 right-6 z-[1000] flex flex-col gap-3">
          <div className="bg-white/90 backdrop-blur-md p-1 rounded-xl shadow-lg border border-black/5 flex gap-1">
            <button 
              onClick={() => setBasemap('osm')}
              className={cn(
                "px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all",
                basemap === 'osm' 
                  ? "bg-blue-600 text-white shadow-md" 
                  : "text-slate-400 hover:text-slate-900 hover:bg-slate-100"
              )}
            >
              Map
            </button>
            <button 
              onClick={() => setBasemap('satellite')}
              className={cn(
                "px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all",
                basemap === 'satellite' 
                  ? "bg-blue-600 text-white shadow-md" 
                  : "text-slate-400 hover:text-slate-900 hover:bg-slate-100"
              )}
            >
              Satellite
            </button>
            <button 
              onClick={() => setOfflineMode(!offlineMode)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1",
                offlineMode 
                  ? "bg-amber-600 text-white shadow-md" 
                  : "text-slate-400 hover:text-slate-900 hover:bg-slate-100"
              )}
              title={offlineMode ? "Offline mode enabled" : "Click to enable offline mode"}
            >
              {offlineMode ? <WifiOff className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
              Offline
            </button>
          </div>

          <div className="bg-white/90 backdrop-blur-md p-4 rounded-2xl shadow-xl border border-black/5 min-w-[200px]">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4 text-black/40" />
              <span className="text-[10px] uppercase tracking-widest font-bold text-black/60">Legend</span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-8 h-0.5" style={{ backgroundColor: settings.flightLineColor }} />
                <span className="text-xs text-black/80 font-medium">Flight Lines</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-0.5 border-t border-dashed" style={{ borderColor: settings.tieLineColor }} />
                <span className="text-xs text-black/80 font-medium">Tie Lines</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-4 bg-black/10 border border-dashed" style={{ borderColor: settings.boundaryColor }} />
                <span className="text-xs text-black/80 font-medium">Survey Boundary</span>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-black/5">
              <Logo light grayscale />
            </div>
          </div>
        </div>

        {!geoJson && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/80 backdrop-blur-md p-8 rounded-3xl shadow-2xl border border-black/5 text-center max-w-md animate-in fade-in zoom-in duration-500">
              <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
                <Navigation className="w-8 h-8 text-blue-600" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2 tracking-tight">Ready for Planning</h2>
              <p className="text-slate-600 text-sm leading-relaxed">
                Upload a shapefile to begin generating optimized drone flight paths. 
                Configure spacing and orientation in the sidebar.
              </p>
            </div>
          </div>
        )}
      </main>
      {/* Elevation Profile Panel */}
      <AnimatePresence>
        {elevationProfile && (
          <motion.div 
            initial={{ y: 300, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 300, opacity: 0 }}
            className="absolute bottom-6 left-80 right-6 z-[1000] bg-white/90 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-200 p-6 h-64 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="w-4 h-4 text-blue-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Elevation Cross-Section Profile</h3>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[8px] text-slate-400 uppercase font-mono">Source: Open-Elevation (SRTM)</span>
                {isFetchingElevation && <Loader2 className="w-3 h-3 animate-spin text-blue-600" />}
                <button 
                  onClick={() => setElevationProfile(null)}
                  className="p-1.5 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            
            <div className="flex-1 w-full min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={elevationProfile}>
                  <defs>
                    <linearGradient id="colorElev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis 
                    dataKey="distance" 
                    tick={{fontSize: 10, fill: '#64748b'}} 
                    label={{ value: 'Distance (m)', position: 'insideBottom', offset: -5, fontSize: 10, fill: '#94a3b8' }}
                  />
                  <YAxis 
                    tick={{fontSize: 10, fill: '#64748b'}}
                    label={{ value: 'Elev (m)', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#94a3b8' }}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'white', borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '10px' }}
                    labelFormatter={(val) => `Distance: ${val}m`}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="elevation" 
                    stroke="#2563eb" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorElev)" 
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
