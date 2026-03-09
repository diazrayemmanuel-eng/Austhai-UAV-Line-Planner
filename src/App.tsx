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
import shpwrite from '@mapbox/shp-write';
import type { Feature, Polygon, MultiPolygon, LineString, FeatureCollection, BBox, Point } from 'geojson';
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
  WifiOff,
  Home,
  Crosshair,
  Ruler,
  StickyNote,
  Copy,
  Check,
  MapPin,
  BarChart3,
  Moon,
  Sun
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
  gridOffsetX: number;   // meters
  gridOffsetY: number;   // meters
}

// Drone types
interface DroneSpec {
  name: string;
  maxFlightTime: number; // minutes
  batteryCapacity: number; // Wh
  cruiseSpeed: number; // m/s
  maxAltitude: number; // meters AGL
  weight: number; // kg
}

interface FlightMissionSettings {
  droneModel: 'M350' | 'M400';
  cruiseSpeed: number; // m/s
  altitude: number; // meters AGL
  returnToHomeAltitude: number; // meters
  batteryUsageBuffer: number; // percentage safety margin
}

interface MissionPoint {
  id: string;
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
  action?: 'hover' | 'photo' | 'video_start' | 'video_stop';
  actionParam?: any;
}

// Drone specifications
const DRONE_SPECS: Record<string, DroneSpec> = {
  'M350': {
    name: 'DJI Matrice 350 RTK',
    maxFlightTime: 55, // minutes (no wind, no payload)
    batteryCapacity: 5590, // Wh
    cruiseSpeed: 15, // m/s (~54 km/h)
    maxAltitude: 7000, // meters
    weight: 9.06 // kg
  },
  'M400': {
    name: 'DJI Matrice 400 RTK',
    maxFlightTime: 46, // minutes (no wind, no payload)
    batteryCapacity: 5935, // Wh (dual battery system = 11870 Wh)
    cruiseSpeed: 15, // m/s (~54 km/h)
    maxAltitude: 7000, // meters
    weight: 9.7 // kg
  }
};

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

// --- Helper Functions for New Features ---

/**
 * Calculate per-line flight statistics
 */
function calculateLineStats(
  line: Feature<LineString>,
  settings: FlightMissionSettings
) {
  const drone = DRONE_SPECS[settings.droneModel];
  
  // Calculate line distance in kilometers
  const lineDistance = turf.length(line, { units: 'kilometers' });
  
  // Calculate flight time for this line (distance / speed)
  const flightTimeMinutes = (lineDistance * 1000) / (settings.cruiseSpeed * 60);
  
  // Add time for altitude changes (assume 2 m/s vertical speed)
  const altitudeTime = (settings.altitude + settings.returnToHomeAltitude) / (2 * 60);
  
  // Add safety buffer
  const totalLineTime = (flightTimeMinutes + altitudeTime) * (1 + settings.batteryUsageBuffer / 100);
  
  // Battery percentage needed for this line
  const batteryPercentage = (totalLineTime / drone.maxFlightTime) * 100;
  
  // Power consumption for this line
  const avgPowerDraw = (drone.batteryCapacity * 0.7) / drone.maxFlightTime;
  const linePowerNeeded = totalLineTime * avgPowerDraw;

  return {
    distance: lineDistance.toFixed(2),
    flightTime: totalLineTime.toFixed(1),
    batteryPercentage: batteryPercentage.toFixed(1),
    powerConsumption: linePowerNeeded.toFixed(0),
    timeString: formatTime(totalLineTime)
  };
}

/**
 * Format time in hours and minutes
 */
function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Advanced flight time calculator with elevation, wind resistance, and payload
 */
interface AdvancedFlightStats {
  totalFlightTime: number; // minutes
  climbTime: number;
  cruiseTime: number;
  descentTime: number;
  hoverTime: number; // minutes spent hovering at waypoints
  totalEnergyWh: number;
  climbEnergyWh: number;
  cruiseEnergyWh: number;
  descentEnergyWh: number;
  hoverEnergyWh: number; // energy consumed during hover/turns
  batteryPercentage: number;
  avgWindResistance: number; // m/s
  elevationGain: number; // meters
  elevationLoss: number; // meters
  horizontalDistance: number; // meters (2D distance)
  actualDistance3D: number; // meters (3D distance including terrain following)
  terrainFollowingFactor: number; // ratio of 3D to 2D distance
  numberOfWaypoints: number;
  numberOfTurns: number;
  terrainType: string; // "Flat", "Rolling", or "Rugged"
  waypointSpacing: number; // meters - adaptive based on terrain
}

/**
 * Calculate wind speed at a given altitude AGL
 * Based on logarithmic wind profile and user-provided data
 */
function getWindSpeedAtAltitude(altitudeAGL: number, surfaceWindSpeed: number = 4.0): number {
  // At 10m (standard weather measurement): surface wind
  // At 30m AGL: 4.0-4.7 m/s (average 4.35)
  // At 80m AGL: 4.5-7.3 m/s (average 5.9)
  
  // Use logarithmic wind profile with power law approximation
  // v(z) = v_ref * (z/z_ref)^alpha where alpha ≈ 0.143 for open terrain
  const referenceHeight = 10; // meters
  const alpha = 0.143; // wind shear exponent for open terrain
  
  if (altitudeAGL < 10) altitudeAGL = 10; // minimum height for calculation
  
  const windAtAltitude = surfaceWindSpeed * Math.pow(altitudeAGL / referenceHeight, alpha);
  
  // Apply realistic bounds based on user specifications
  if (altitudeAGL <= 30) {
    return Math.min(Math.max(windAtAltitude, 4.0), 4.7);
  } else if (altitudeAGL >= 80) {
    return Math.min(Math.max(windAtAltitude, 4.5), 7.3);
  } else {
    // Linear interpolation between 30m and 80m
    const factor = (altitudeAGL - 30) / (80 - 30);
    const windAt30 = Math.min(Math.max(surfaceWindSpeed * Math.pow(30 / referenceHeight, alpha), 4.0), 4.7);
    const windAt80 = Math.min(Math.max(surfaceWindSpeed * Math.pow(80 / referenceHeight, alpha), 4.5), 7.3);
    return windAt30 + (windAt80 - windAt30) * factor;
  }
}

/**
 * Calculate power consumption for drone with payload
 * @param drone - Drone specifications
 * @param verticalSpeed - Vertical speed in m/s (positive = climbing, negative = descending, 0 = cruise)
 * @param horizontalSpeed - Horizontal speed in m/s
 * @param altitude - Altitude AGL in meters
 * @param surfaceWindSpeed - Wind speed at 10m AGL
 * @param payloadKg - Payload weight in kg (default 1.2kg for mag arrow)
 */
function calculatePowerConsumption(
  drone: DroneSpec,
  verticalSpeed: number,
  horizontalSpeed: number,
  altitude: number,
  surfaceWindSpeed: number = 4.0,
  payloadKg: number = 1.2
): number {
  // Base power consumption (hovering with no payload) - approximately 40% of max power
  const basePowerWatts = (drone.batteryCapacity / (drone.maxFlightTime / 60)) * 0.4;
  
  // Payload effect: additional power needed to carry extra weight
  // Roughly 3-5% increase per kg of payload for multirotor drones
  const payloadFactor = 1 + (payloadKg * 0.04);
  
  // Climbing: significantly more power (50-100% increase)
  // Descending: less power (can use negative thrust, 20-40% of hover)
  let verticalPowerFactor = 1.0;
  if (verticalSpeed > 0) {
    // Climbing: exponential increase with climb rate
    verticalPowerFactor = 1 + (verticalSpeed / 2.0) * 1.5; // 2 m/s climb = ~2.5x hover power
  } else if (verticalSpeed < 0) {
    // Descending: reduced power
    verticalPowerFactor = 0.3 + Math.abs(verticalSpeed) * 0.05; // Gentle descent uses ~30-40% hover power
  }
  
  // Horizontal speed factor: power increases with speed (drag increases quadratically)
  // At cruise speed (15 m/s), roughly 1.2-1.4x hover power
  const speedFactor = 1 + Math.pow(horizontalSpeed / drone.cruiseSpeed, 2) * 0.4;
  
  // Wind resistance at altitude: additional power needed to maintain course
  const windAtAltitude = getWindSpeedAtAltitude(altitude, surfaceWindSpeed);
  const windFactor = 1 + (windAtAltitude / 10) * 0.15; // Each 10 m/s wind adds ~15% power
  
  // Total power = base × payload × vertical × speed × wind
  const totalPowerWatts = basePowerWatts * payloadFactor * verticalPowerFactor * speedFactor * windFactor;
  
  return totalPowerWatts;
}

/**
 * Calculate advanced flight statistics for a line considering elevation, wind, and payload
 */
async function calculateAdvancedLineStats(
  line: Feature<LineString>,
  settings: FlightMissionSettings,
  surfaceWindSpeed: number = 4.0
): Promise<AdvancedFlightStats> {
  const drone = DRONE_SPECS[settings.droneModel];
  const coords = line.geometry.coordinates;
  const lineString = turf.lineString(coords);
  const totalDistance = turf.length(lineString, { units: 'meters' });
  
  // Fetch elevation profile for the line
  // UAV mag survey optimal waypoint spacing: 10-20m (sweet spot)
  // - Flat/rolling terrain: 20m spacing is acceptable
  // - Rugged terrain: 10-15m for accurate terrain following
  // - Too wide (>50m): drone shortcuts terrain, inconsistent AGL
  // - Too tight (<2m): flight controller stuttering, motion noise
  const waypointSpacing = 15; // meters - optimal for mag surveys
  const numSegments = Math.max(10, Math.floor(totalDistance / waypointSpacing));
  const points = [];
  
  for (let i = 0; i <= numSegments; i++) {
    const dist = (totalDistance / numSegments) * i;
    const point = turf.along(lineString, dist, { units: 'meters' });
    points.push({
      latitude: point.geometry.coordinates[1],
      longitude: point.geometry.coordinates[0],
      distance: dist
    });
  }
  
  // Fetch elevation data
  let elevations: number[] = [];
  try {
    const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        locations: points.map(p => ({ latitude: p.latitude, longitude: p.longitude })) 
      })
    });
    
    if (res.ok) {
      const data = await res.json();
      elevations = data.results.map((r: any) => r.elevation);
    } else {
      // Fallback: assume relatively flat terrain with minor variations
      elevations = points.map(() => 100 + Math.random() * 10);
    }
  } catch (error) {
    console.error("Elevation fetch failed, using fallback:", error);
    elevations = points.map(() => 100 + Math.random() * 10);
  }
  
  // Analyze terrain ruggedness to determine optimal waypoint spacing for mag survey
  // Calculate elevation variance to classify terrain type
  const maxElev = Math.max(...elevations);
  const minElev = Math.min(...elevations);
  const elevRange = maxElev - minElev;
  const elevVariance = elevRange / (totalDistance / 1000); // meters elevation change per km
  
  // Determine optimal waypoint spacing based on terrain ruggedness
  // - Flat terrain (<20m/km): 20m spacing
  // - Rolling terrain (20-50m/km): 15m spacing  
  // - Rugged terrain (>50m/km): 10m spacing
  let actualWaypointSpacing: number;
  let terrainType: string;
  
  if (elevVariance < 20) {
    actualWaypointSpacing = 20; // Flat to gently rolling
    terrainType = "Flat";
  } else if (elevVariance < 50) {
    actualWaypointSpacing = 15; // Rolling terrain (default)
    terrainType = "Rolling";
  } else {
    actualWaypointSpacing = 10; // Rugged/steep terrain
    terrainType = "Rugged";
  }
  
  // Calculate stats for each segment
  let totalTime = 0;
  let totalEnergy = 0;
  let climbTime = 0, cruiseTime = 0, descentTime = 0, hoverTime = 0;
  let climbEnergy = 0, cruiseEnergy = 0, descentEnergy = 0, hoverEnergy = 0;
  let elevationGain = 0, elevationLoss = 0;
  let actual3DDistance = 0; // Track actual distance including vertical displacement
  
  // Initial climb to mission altitude
  const startElevation = elevations[0];
  const climbToAltitude = settings.altitude;
  const climbRate = 2.0; // m/s
  const initialClimbTime = climbToAltitude / climbRate / 60; // minutes
  const initialClimbPower = calculatePowerConsumption(drone, climbRate, 0, settings.altitude / 2, surfaceWindSpeed);
  const initialClimbEnergy = (initialClimbPower / 1000) * (initialClimbTime / 60); // kWh to Wh
  
  totalTime += initialClimbTime;
  totalEnergy += initialClimbEnergy;
  climbTime += initialClimbTime;
  climbEnergy += initialClimbEnergy;
  
  // Count waypoints and turns for hover energy calculation
  // For UAV mag surveys, waypoints are placed every 10-20m for accurate terrain following
  // This is NOT just the line endpoints, but the actual flight path waypoints
  // Spacing is adaptive based on terrain ruggedness
  const numberOfWaypoints = Math.floor(totalDistance / actualWaypointSpacing) + 1;
  const numberOfTurns = Math.max(0, numberOfWaypoints - 2); // Turns at intermediate waypoints
  
  // Process each segment
  for (let i = 0; i < numSegments; i++) {
    const segmentDist = totalDistance / numSegments; // 2D horizontal distance
    const elevDiff = elevations[i + 1] - elevations[i];
    const droneAltitude = settings.altitude + elevations[i] - startElevation;
    
    // Calculate actual 3D distance (hypotenuse) for terrain following
    // When flying at constant AGL, vertical displacement = elevation change
    const segment3DDistance = Math.sqrt(
      Math.pow(segmentDist, 2) + Math.pow(Math.abs(elevDiff), 2)
    );
    actual3DDistance += segment3DDistance;
    
    // Calculate segment time based on 3D distance
    const horizontalSpeed = settings.cruiseSpeed;
    const segmentTimeSeconds = segment3DDistance / horizontalSpeed;
    const segmentTimeMinutes = segmentTimeSeconds / 60;
    
    // Determine vertical speed for terrain following
    let verticalSpeed = 0;
    if (Math.abs(elevDiff) > 1) { // Only consider elevation changes > 1m
      verticalSpeed = elevDiff / segmentTimeSeconds;
      // Limit to realistic vertical speeds while cruising
      verticalSpeed = Math.max(-3, Math.min(3, verticalSpeed));
    }
    
    // Calculate power for this segment with terrain following
    const segmentPower = calculatePowerConsumption(
      drone,
      verticalSpeed,
      horizontalSpeed,
      droneAltitude,
      surfaceWindSpeed,
      1.2 // mag arrow payload
    );
    
    const segmentEnergy = (segmentPower / 1000) * (segmentTimeMinutes / 60); // Wh
    
    totalTime += segmentTimeMinutes;
    totalEnergy += segmentEnergy;
    
    // Categorize segment
    if (verticalSpeed > 0.5) {
      climbTime += segmentTimeMinutes;
      climbEnergy += segmentEnergy;
      elevationGain += Math.abs(elevDiff);
    } else if (verticalSpeed < -0.5) {
      descentTime += segmentTimeMinutes;
      descentEnergy += segmentEnergy;
      elevationLoss += Math.abs(elevDiff);
    } else {
      cruiseTime += segmentTimeMinutes;
      cruiseEnergy += segmentEnergy;
    }
  }
  
  // Add hover/turn energy at waypoints
  // Assume 2 seconds hover per waypoint and 1 second per turn (sharp direction change)
  const hoverSecondsPerWaypoint = 2; // seconds
  const turnSecondsPerTurn = 1; // seconds for deceleration/acceleration
  const totalHoverSeconds = (numberOfWaypoints * hoverSecondsPerWaypoint) + (numberOfTurns * turnSecondsPerTurn);
  const hoverTimeMinutes = totalHoverSeconds / 60;
  
  // Hovering consumes more power than cruising (need to maintain altitude with no forward momentum)
  const hoverPower = calculatePowerConsumption(drone, 0, 0, settings.altitude, surfaceWindSpeed, 1.2);
  const hoverEnergyWh = (hoverPower / 1000) * (hoverTimeMinutes / 60);
  
  totalTime += hoverTimeMinutes;
  totalEnergy += hoverEnergyWh;
  hoverTime = hoverTimeMinutes;
  hoverEnergy = hoverEnergyWh;
  
  // Final descent back to landing
  const descentFromAltitude = settings.returnToHomeAltitude || settings.altitude;
  const descentRate = 2.0; // m/s
  const finalDescentTime = descentFromAltitude / descentRate / 60; // minutes
  const finalDescentPower = calculatePowerConsumption(drone, -descentRate, 0, descentFromAltitude / 2, surfaceWindSpeed);
  const finalDescentEnergy = (finalDescentPower / 1000) * (finalDescentTime / 60);
  
  totalTime += finalDescentTime;
  totalEnergy += finalDescentEnergy;
  descentTime += finalDescentTime;
  descentEnergy += finalDescentEnergy;
  
  // Apply safety buffer (20-25% reserve for safe landing)
  const bufferFactor = 1 + (settings.batteryUsageBuffer / 100);
  totalTime *= bufferFactor;
  totalEnergy *= bufferFactor;
  
  // Calculate battery percentage
  const batteryPercentage = (totalEnergy / drone.batteryCapacity) * 100;
  
  // Average wind resistance
  const avgAltitude = settings.altitude;
  const avgWindResistance = getWindSpeedAtAltitude(avgAltitude, surfaceWindSpeed);
  
  // Calculate terrain following factor (ratio of 3D to 2D distance)
  const terrainFollowingFactor = actual3DDistance / totalDistance;
  
  return {
    totalFlightTime: totalTime,
    climbTime,
    cruiseTime,
    descentTime,
    hoverTime,
    totalEnergyWh: totalEnergy,
    climbEnergyWh: climbEnergy,
    cruiseEnergyWh: cruiseEnergy,
    descentEnergyWh: descentEnergy,
    hoverEnergyWh: hoverEnergy,
    batteryPercentage,
    avgWindResistance,
    elevationGain,
    elevationLoss,
    horizontalDistance: totalDistance,
    actualDistance3D: actual3DDistance,
    terrainFollowingFactor,
    numberOfWaypoints,
    numberOfTurns,
    terrainType,
    waypointSpacing: actualWaypointSpacing
  };
}

// --- Components ---

const Logo = ({ className = "", grayscale = false, light = false, size = "large" }: { className?: string, grayscale?: boolean, light?: boolean, size?: "small" | "medium" | "large" }) => {
  const sizeClasses = {
    small: "w-10 h-10 p-1",
    medium: "w-16 h-16 p-1.5",
    large: "w-24 h-24 p-2"
  };
  
  return (
    <div className={cn("flex items-center justify-center gap-3", className, grayscale && "grayscale opacity-50")}>
      <img 
        src={austaThaiLogo} 
        alt="Austhai Logo" 
        className={cn("object-contain rounded-xl shadow-lg shadow-blue-600/10 shrink-0 border border-slate-100 bg-white", sizeClasses[size])}
      />
    </div>
  );
};

function MapController({ bounds, onMapClick, setMapInstance, onMouseMove }: { 
  bounds: BBox | null, 
  onMapClick?: (e: any) => void, 
  setMapInstance?: (map: L.Map) => void,
  onMouseMove?: (e: any) => void 
}) {
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

  useEffect(() => {
    if (onMouseMove) {
      map.on('mousemove', onMouseMove);
      return () => { map.off('mousemove', onMouseMove); };
    }
  }, [map, onMouseMove]);

  return null;
}

// --- Uploaded File Type ---
interface UploadedFile {
  id: string;
  name: string;
  geoJson: FeatureCollection;
}

interface DgpsThresholdSettings {
  ndviMax: number;
  ndbiMin: number;
  minElevation: number;
}

interface DgpsEditAction {
  type: 'add-manual' | 'remove-manual' | 'remove-generated';
  candidateId: string;
  candidate: Feature<Point>;
}

interface DgpsValidationRecord {
  candidateId: string;
  score: number;
  label: 'accepted' | 'rejected';
  source: string;
  timestamp: number;
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
    gridOffsetX: 0,
    gridOffsetY: 0
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [exportFormat, setExportFormat] = useState<'geojson' | 'kml' | 'kmz' | 'csv' | 'preflight-kml' | 'preflight-kmz' | 'dgps-shp'>('geojson');
  const [preflightFilePrefix, setPreflightFilePrefix] = useState<string>('');
  
  // Manual Editing State
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [deletedLineIds, setDeletedLineIds] = useState<Set<string>>(new Set());
  const [modifiedLines, setModifiedLines] = useState<Record<string, Feature<LineString>>>({});
  const [isEditMode, setIsEditMode] = useState(false);
  const [manualEditCounter, setManualEditCounter] = useState(0);
  
  // Imported Line Plans State
  const [importedLineFeatures, setImportedLineFeatures] = useState<Feature<LineString>[]>([]);
  const [importedLinesFileName, setImportedLinesFileName] = useState<string>('');
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [basemap, setBasemap] = useState<'osm' | 'satellite' | 'offline'>('osm');
  const [offlineMode, setOfflineMode] = useState(false);
  const [localTileServerUrl, setLocalTileServerUrl] = useState('http://localhost:8080');
  const [useLocalTiles, setUseLocalTiles] = useState(false);
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const [showFlightLines, setShowFlightLines] = useState(true);
  const [showTieLines, setShowTieLines] = useState(true);
  const [areaUnit, setAreaUnit] = useState<'m2' | 'km2' | 'hectare'>('km2');
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [elevationProfile, setElevationProfile] = useState<{distance: number, elevation: number}[] | null>(null);
  const [isFetchingElevation, setIsFetchingElevation] = useState(false);
  
  // New features state
  const [showLineLabels, setShowLineLabels] = useState(true);
  const [homePoint, setHomePoint] = useState<{lat: number, lng: number} | null>(null);
  const [cursorCoords, setCursorCoords] = useState<{lat: number, lng: number} | null>(null);
  const [lineProgress, setLineProgress] = useState<Record<string, 'completed' | 'in-progress' | 'pending'>>({}); // Track completion status per line ID
  const [measurementMode, setMeasurementMode] = useState<'off' | 'distance' | 'area'>('off');
  const [measurementPoints, setMeasurementPoints] = useState<[number, number][]>([]);
  const [notes, setNotes] = useState<Array<{id: string, lat: number, lng: number, text: string}>>([]);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [lineLabels, setLineLabels] = useState<Record<string, {start: string, end: string}>>({});
  const [editingLabel, setEditingLabel] = useState<{lineId: string, position: 'start' | 'end', currentValue: string} | null>(null);
  const [editingNote, setEditingNote] = useState<{lat: number, lng: number, currentValue: string} | null>(null);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved ? JSON.parse(saved) : false;
  });

  // Default mission settings used for per-line calculations and exports
  const defaultMissionSettings: FlightMissionSettings = {
    droneModel: 'M350',
    cruiseSpeed: 15,
    altitude: 100,
    returnToHomeAltitude: 50,
    batteryUsageBuffer: 20 // 20-25% recommended for safe landing reserve
  };

  const [advancedFlightStats, setAdvancedFlightStats] = useState<AdvancedFlightStats | null>(null);
  const [isFetchingAdvancedStats, setIsFetchingAdvancedStats] = useState(false);
  const [showAdvancedStats, setShowAdvancedStats] = useState(false);

  // DGPS candidate workflow state
  const [showDgpsCandidates, setShowDgpsCandidates] = useState(true);
  const [dgpsThresholds, setDgpsThresholds] = useState<DgpsThresholdSettings>({
    ndviMax: 0.2,
    ndbiMin: 0.1,
    minElevation: 300
  });
  const [dgpsMaxCandidates, setDgpsMaxCandidates] = useState(15);
  const [dgpsEditMode, setDgpsEditMode] = useState<'off' | 'add' | 'remove'>('off');
  const [manualDgpsPoints, setManualDgpsPoints] = useState<Feature<Point>[]>([]);
  const [removedGeneratedCandidateIds, setRemovedGeneratedCandidateIds] = useState<Set<string>>(new Set());
  const [dgpsEditHistory, setDgpsEditHistory] = useState<DgpsEditAction[]>([]);
  const [selectedDgpsCandidateId, setSelectedDgpsCandidateId] = useState<string | null>(null);
  const [dgpsValidationRecords, setDgpsValidationRecords] = useState<Record<string, DgpsValidationRecord>>(() => {
    try {
      const raw = localStorage.getItem('dgpsValidationRecords');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const fetchElevationProfile = async (line: Feature<LineString>) => {
    setIsFetchingElevation(true);
    const points: { distance: number; lat: number; lon: number }[] = [];
    try {
      const coords = line.geometry.coordinates;
      const lineString = turf.lineString(coords);
      const length = turf.length(lineString, { units: 'meters' });
      const numSamples = 20;

      for (let i = 0; i <= numSamples; i++) {
        const distance = (length * i) / numSamples;
        const samplePoint = turf.along(lineString, distance, { units: 'meters' });
        const [lon, lat] = samplePoint.geometry.coordinates;
        points.push({ distance, lat, lon });
      }

      const locations = points.map((p) => `${p.lat},${p.lon}`).join('|');
      const response = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`);

      if (!response.ok) {
        throw new Error(`Elevation API failed with status ${response.status}`);
      }

      const data: { results?: Array<{ elevation?: number }> } = await response.json();
      const profile = points.map((p, idx) => ({
        distance: Math.round(p.distance),
        elevation: Math.round(data.results?.[idx]?.elevation ?? 0)
      }));
      setElevationProfile(profile);
    } catch (err) {
      console.error('Failed to fetch elevation profile:', err);
      // Fallback: keep chart usable even when API is unavailable.
      setElevationProfile(points.map((p) => ({ distance: Math.round(p.distance), elevation: 0 })));
    } finally {
      setIsFetchingElevation(false);
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem('surveyNotes', JSON.stringify(notes));
    } catch (err) {
      console.error('Failed to save notes:', err);
    }
  }, [notes]);

  // Save home point to localStorage
  useEffect(() => {
    try {
      if (homePoint) {
        localStorage.setItem('homePoint', JSON.stringify(homePoint));
      } else {
        localStorage.removeItem('homePoint');
      }
    } catch (err) {
      console.error('Failed to save home point:', err);
    }
  }, [homePoint]);

  // Save line labels to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('lineLabels', JSON.stringify(lineLabels));
    } catch (err) {
      console.error('Failed to save line labels:', err);
    }
  }, [lineLabels]);

  useEffect(() => {
    try {
      localStorage.setItem('dgpsValidationRecords', JSON.stringify(dgpsValidationRecords));
    } catch (err) {
      console.error('Failed to save DGPS validation records:', err);
    }
  }, [dgpsValidationRecords]);

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

  // When a line plan is imported, use it as the active plan and do not append auto-generated lines.
  const allFlightLines = useMemo(() => {
    const hasImportedPlan = importedLineFeatures.length > 0;
    const generated = hasImportedPlan ? [] : (flightLines?.features || []);
    const imported = importedLineFeatures.filter(f => {
      const lineType = f.properties?.type?.toLowerCase();
      return !lineType || lineType === 'flight' || lineType.startsWith('fl');
    });
    
    // Apply edits to imported lines as well
    const editedImported = imported
      .filter(f => !deletedLineIds.has(String(f.id)))
      .map(f => modifiedLines[String(f.id)] || f);
    
    return turf.featureCollection([...generated, ...editedImported]);
  }, [flightLines, importedLineFeatures, deletedLineIds, modifiedLines]);

  const allTieLines = useMemo(() => {
    const hasImportedPlan = importedLineFeatures.length > 0;
    const generated = hasImportedPlan ? [] : (tieLines?.features || []);
    const imported = importedLineFeatures.filter(f => {
      const lineType = f.properties?.type?.toLowerCase();
      return lineType === 'tie' || lineType?.startsWith('tl');
    });
    
    // Apply edits to imported lines as well
    const editedImported = imported
      .filter(f => !deletedLineIds.has(String(f.id)))
      .map(f => modifiedLines[String(f.id)] || f);
    
    return turf.featureCollection([...generated, ...editedImported]);
  }, [tieLines, importedLineFeatures, deletedLineIds, modifiedLines]);

  const bbox = useMemo(() => {
    if (!mainPolygon) return null;
    return turf.bbox(mainPolygon);
  }, [mainPolygon]);

  const stats = useMemo(() => {
    if (!allFlightLines || !allTieLines) return null;
    const fLength = turf.length(allFlightLines, { units: 'kilometers' });
    const tLength = turf.length(allTieLines, { units: 'kilometers' });
    const area = mainPolygon ? turf.area(mainPolygon) / 1000000 : 0; // km2
    return {
      flightLength: fLength.toFixed(2),
      tieLength: tLength.toFixed(2),
      totalLength: (fLength + tLength).toFixed(2),
      area: area.toFixed(3)
    };
  }, [allFlightLines, allTieLines, mainPolygon]);

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

  const dgpsCandidates = useMemo(() => {
    if (!mainPolygon) return null;

    // Deterministic pseudo index generator for offline candidate preview.
    const pseudo = (lon: number, lat: number, seed: number) => {
      const value = Math.sin((lon * 12.9898 + lat * 78.233 + seed) * 43758.5453) * 10000;
      return value - Math.floor(value);
    };

    const aoiBbox = turf.bbox(mainPolygon);
    const areaKm2 = turf.area(mainPolygon) / 1_000_000;
    const spacingKm = Math.max(0.1, Math.min(0.5, Math.sqrt(Math.max(areaKm2, 0.1)) / 5));
    const grid = turf.pointGrid(aoiBbox, spacingKm, { units: 'kilometers', mask: mainPolygon });

    // Keep generation bounded for responsiveness on large AOIs.
    const maxGridPoints = 2000;
    const gridFeatures = grid.features.slice(0, maxGridPoints);

    const generatedCandidates: Feature<Point>[] = gridFeatures
      .map((feature, idx) => {
        const [lon, lat] = feature.geometry.coordinates;

        const ndvi = -0.15 + pseudo(lon, lat, 11 + idx * 0.01) * 0.9;
        const ndbi = -0.25 + pseudo(lon, lat, 23 + idx * 0.01) * 0.95;
        const elevation = 50 + pseudo(lon, lat, 37 + idx * 0.01) * 2800;
        const slope = pseudo(lon, lat, 41 + idx * 0.01) * 12;

        const passes =
          ndvi <= dgpsThresholds.ndviMax &&
          ndbi >= dgpsThresholds.ndbiMin &&
          elevation >= dgpsThresholds.minElevation;

        if (!passes) return null;

        const ndviScore = Math.max(0, Math.min(1, (dgpsThresholds.ndviMax - ndvi + 1) / 2));
        const ndbiScore = Math.max(0, Math.min(1, (ndbi - dgpsThresholds.ndbiMin + 1) / 2));
        const elevScore = Math.max(0, Math.min(1, (elevation - dgpsThresholds.minElevation) / 1200));
        const slopeScore = Math.max(0, Math.min(1, 1 - slope / 12));

        const score = (ndviScore * 0.3 + ndbiScore * 0.3 + elevScore * 0.25 + slopeScore * 0.15) * 100;

        return turf.point([lon, lat], {
          ndvi: Number(ndvi.toFixed(3)),
          ndbi: Number(ndbi.toFixed(3)),
          elevationM: Number(elevation.toFixed(1)),
          slopeDeg: Number(slope.toFixed(2)),
          score: Number(score.toFixed(1)),
          candidateId: `DGPS-${idx + 1}`
        });
      })
      .filter((feature): feature is Feature<Point> => feature !== null)
      .filter((feature) => !removedGeneratedCandidateIds.has(String(feature.properties?.candidateId ?? '')))
      .sort((a, b) => (Number(b.properties?.score ?? 0) - Number(a.properties?.score ?? 0)))
      .slice(0, dgpsMaxCandidates)
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          source: 'generated'
        }
      }));

    const mergedCandidates = [...generatedCandidates, ...manualDgpsPoints]
      .sort((a, b) => (Number(b.properties?.score ?? 0) - Number(a.properties?.score ?? 0)))
      .map((feature, index) => ({
        ...feature,
        properties: {
          ...feature.properties,
          rank: index + 1
        }
      }));

    return turf.featureCollection(mergedCandidates);
  }, [mainPolygon, dgpsThresholds, dgpsMaxCandidates, manualDgpsPoints, removedGeneratedCandidateIds]);

  const selectedDgpsCandidate = useMemo(() => {
    if (!selectedDgpsCandidateId || !dgpsCandidates) return null;
    return dgpsCandidates.features.find(
      f => String(f.properties?.candidateId ?? '') === selectedDgpsCandidateId
    ) ?? null;
  }, [selectedDgpsCandidateId, dgpsCandidates]);

  const dgpsValidationStats = useMemo(() => {
    const records = Object.values(dgpsValidationRecords);
    const accepted = records.filter(r => r.label === 'accepted').length;
    const rejected = records.filter(r => r.label === 'rejected').length;
    const total = records.length;
    return {
      accepted,
      rejected,
      total,
      acceptanceRate: total > 0 ? accepted / total : 0
    };
  }, [dgpsValidationRecords]);

  const estimateDgpsSuitabilityProbability = useCallback((score: number) => {
    const records = Object.values(dgpsValidationRecords);
    if (records.length === 0) {
      return 0.5;
    }

    const localSamples = records.filter(r => Math.abs(r.score - score) <= 10);
    const sampleSet = localSamples.length >= 5 ? localSamples : records;

    const accepted = sampleSet.filter(r => r.label === 'accepted').length;
    const total = sampleSet.length;

    // Laplace smoothing avoids unstable 0/100% with small sample sizes.
    return (accepted + 1) / (total + 2);
  }, [dgpsValidationRecords]);

  const normalizeAngle180 = (angleDeg: number) => {
    let normalized = angleDeg % 180;
    if (normalized < 0) normalized += 180;
    return normalized;
  };

  const getReferenceLonLat = (lines: Feature<LineString>[]) => {
    const allCoords = lines.flatMap(line => line.geometry.coordinates);
    if (allCoords.length === 0) return { lon: 0, lat: 0 };

    const lon = allCoords.reduce((sum, c) => sum + c[0], 0) / allCoords.length;
    const lat = allCoords.reduce((sum, c) => sum + c[1], 0) / allCoords.length;
    return { lon, lat };
  };

  const toLocalMeters = (coord: number[], ref: { lon: number; lat: number }) => {
    const latRad = (ref.lat * Math.PI) / 180;
    const metersPerDegLon = 111320 * Math.cos(latRad);
    const metersPerDegLat = 110540;
    const x = (coord[0] - ref.lon) * metersPerDegLon;
    const y = (coord[1] - ref.lat) * metersPerDegLat;
    return { x, y };
  };

  const getLineAzimuth = (feature: Feature<LineString>, ref: { lon: number; lat: number }) => {
    const coords = feature.geometry.coordinates;
    if (!coords || coords.length < 2) return 0;
    const start = toLocalMeters(coords[0], ref);
    const end = toLocalMeters(coords[coords.length - 1], ref);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    return normalizeAngle180(angle);
  };

  const isTieLineFeature = (feature: Feature<LineString>) => {
    const rawType = String(feature.properties?.type ?? '').toLowerCase();
    return rawType === 'tie' || rawType.includes('tie') || rawType.startsWith('tl');
  };

  const isFlightLineFeature = (feature: Feature<LineString>) => {
    const rawType = String(feature.properties?.type ?? '').toLowerCase();
    if (!rawType) return true;
    if (isTieLineFeature(feature)) return false;
    return rawType === 'flight' || rawType.includes('flight') || rawType.startsWith('fl');
  };

  const circularMean180 = (angles: number[]) => {
    if (angles.length === 0) return 0;
    // Double-angle trick for 180-degree periodicity.
    const doubled = angles.map(a => (2 * a * Math.PI) / 180);
    const sx = doubled.reduce((sum, a) => sum + Math.cos(a), 0);
    const sy = doubled.reduce((sum, a) => sum + Math.sin(a), 0);
    const mean = (Math.atan2(sy, sx) * 180) / Math.PI / 2;
    return normalizeAngle180(mean);
  };

  const circularDistance180 = (a: number, b: number) => {
    const d = Math.abs(normalizeAngle180(a) - normalizeAngle180(b));
    return Math.min(d, 180 - d);
  };

  const estimateDominantAngle = (angles: number[]) => {
    if (angles.length === 0) return 0;
    const binSize = 5;
    const bins = new Array(Math.ceil(180 / binSize)).fill(0) as number[];

    angles.forEach(a => {
      const idx = Math.floor(normalizeAngle180(a) / binSize) % bins.length;
      bins[idx] += 1;
    });

    let bestIdx = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i] > bins[bestIdx]) bestIdx = i;
    }

    const center = bestIdx * binSize + binSize / 2;
    const inBin = angles.filter(a => circularDistance180(a, center) <= binSize);
    return circularMean180(inBin.length > 0 ? inBin : angles);
  };

  const estimateSpacingMeters = (
    lines: Feature<LineString>[],
    lineAngleDeg: number,
    ref: { lon: number; lat: number }
  ) => {
    if (lines.length < 2) return null;

    const normalRad = ((lineAngleDeg + 90) * Math.PI) / 180;
    const nx = Math.cos(normalRad);
    const ny = Math.sin(normalRad);

    const projections = lines.map(line => {
      const start = toLocalMeters(line.geometry.coordinates[0], ref);
      const end = toLocalMeters(line.geometry.coordinates[line.geometry.coordinates.length - 1], ref);
      const mx = (start.x + end.x) / 2;
      const my = (start.y + end.y) / 2;
      return mx * nx + my * ny;
    }).sort((a, b) => a - b);

    const distances: number[] = [];
    for (let i = 1; i < projections.length; i++) {
      const p1 = projections[i - 1];
      const p2 = projections[i];
      const meters = Math.abs(p2 - p1);
      if (meters > 1) distances.push(meters);
    }

    if (distances.length === 0) return null;
    distances.sort((a, b) => a - b);

    // Robust median with mild outlier rejection.
    const rawMedian = distances[Math.floor(distances.length / 2)];
    const filtered = distances.filter(d => d <= rawMedian * 3);
    const source = filtered.length > 0 ? filtered : distances;
    return source[Math.floor(source.length / 2)];
  };

  const inferSettingsFromImportedLines = (lines: Feature<LineString>[]) => {
    const ref = getReferenceLonLat(lines);
    const flightTagged = lines.filter(isFlightLineFeature);
    const tieTagged = lines.filter(isTieLineFeature);

    const allAngles = lines.map(line => getLineAzimuth(line, ref));
    const dominantAngle = estimateDominantAngle(allAngles);

    const defaultFlightSet = lines.filter(
      line => circularDistance180(getLineAzimuth(line, ref), dominantAngle) <= 20
    );

    const defaultTieSet = lines.filter(
      line => circularDistance180(getLineAzimuth(line, ref), normalizeAngle180(dominantAngle + 90)) <= 20
    );

    const flightSet = flightTagged.length >= 2 ? flightTagged : defaultFlightSet;
    const tieSet = tieTagged.length >= 2 ? tieTagged : defaultTieSet;

    const inferredAngle = flightSet.length > 0
      ? circularMean180(flightSet.map(line => getLineAzimuth(line, ref)))
      : dominantAngle;

    const inferredFlightSpacing = estimateSpacingMeters(
      flightSet.length >= 2 ? flightSet : lines,
      inferredAngle,
      ref
    );

    const tieAngle = normalizeAngle180(inferredAngle + 90);
    const inferredTieSpacing = tieSet.length >= 2
      ? estimateSpacingMeters(tieSet, tieAngle, ref)
      : null;

    return {
      angle: Math.round(inferredAngle),
      flightLineSpacing: inferredFlightSpacing ? Math.max(5, Math.round(inferredFlightSpacing)) : null,
      tieLineSpacing: inferredTieSpacing ? Math.max(5, Math.round(inferredTieSpacing)) : null
    };
  };

  // Handlers
  // Parse CSV line plan files
  const parseLinePlanCSV = (csvText: string): Feature<LineString>[] => {
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l);
    const features: Feature<LineString>[] = [];
    
    if (lines.length === 0) return features;

    // Helper to parse CSV fields (handle quoted fields)
    const parseCSVLine = (line: string): string[] => {
      const fields: string[] = [];
      let inQuote = false;
      let field = '';
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
          fields.push(field.trim());
          field = '';
        } else {
          field += char;
        }
      }
      fields.push(field.trim());
      return fields;
    };

    // Scan for header and data rows
    let headerIdx = -1;
    let dataStartIdx = 0;

    // Look for header row (contains text like StartLat, StartLng, etc.)
    const headerPatterns = /start|end|lat|lng|easting|northing|x|y|lon|longitude|latitude/i;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const fields = parseCSVLine(lines[i]);
      let matchCount = 0;
      fields.forEach(f => {
        if (headerPatterns.test(f)) matchCount++;
      });
      if (matchCount >= 2) {
        headerIdx = i;
        dataStartIdx = i + 1;
        console.log('Detected CSV header at line', i, ':', fields);
        break;
      }
    }

    // If no header found, assume first data row at line 0 or skip detection
    if (headerIdx === -1) {
      // Scan for first line with numeric coordinates
      for (let i = 0; i < Math.min(10, lines.length); i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length >= 5) {
          // Try to find numeric fields
          const numericCount = fields.filter(f => !isNaN(parseFloat(f))).length;
          if (numericCount >= 4) {
            dataStartIdx = i;
            console.log('Detected data start at line', i);
            break;
          }
        }
      }
    }

    // Identify which columns contain coordinates
    // Check first numeric row to identify column structure
    let coordColumns = { startLng: 3, startLat: 4, endLng: 5, endLat: 6 }; // Default
    
    if (dataStartIdx > 0 && dataStartIdx < lines.length) {
      const firstDataFields = parseCSVLine(lines[dataStartIdx]);
      
      // Try to detect by column count and position
      // Common formats:
      // 1. LineID, Type, ..., StartLng, StartLat, EndLng, EndLat (fields 3-6)
      // 2. LineID, Type, StartLng, StartLat, EndLng, EndLat (fields 2-5)
      // 3. LineID, StartLng, StartLat, EndLng, EndLat (fields 1-4)
      
      if (firstDataFields.length >= 7) {
        coordColumns = { startLng: 3, startLat: 4, endLng: 5, endLat: 6 };
      } else if (firstDataFields.length >= 6) {
        coordColumns = { startLng: 2, startLat: 3, endLng: 4, endLat: 5 };
      } else if (firstDataFields.length >= 5) {
        coordColumns = { startLng: 1, startLat: 2, endLng: 3, endLat: 4 };
      }
      
      console.log('Using coordinate columns:', coordColumns);
    }

    for (let i = dataStartIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const fields = parseCSVLine(line);

      if (fields.length < 5) continue;

      try {
        const lineId = fields[0]?.replace(/"/g, '') || `line-${i}`;
        const lineType = fields[1]?.replace(/"/g, '') || 'flight';

        // Extract coordinates with fallback
        const coord1Str = fields[coordColumns.startLng]?.replace(/"/g, '') || '0';
        const coord2Str = fields[coordColumns.startLat]?.replace(/"/g, '') || '0';
        const coord3Str = fields[coordColumns.endLng]?.replace(/"/g, '') || '0';
        const coord4Str = fields[coordColumns.endLat]?.replace(/"/g, '') || '0';

        const coord1 = parseFloat(coord1Str);
        const coord2 = parseFloat(coord2Str);
        const coord3 = parseFloat(coord3Str);
        const coord4 = parseFloat(coord4Str);

        if (!isNaN(coord1) && !isNaN(coord2) && !isNaN(coord3) && !isNaN(coord4)) {
          let startLng = coord1;
          let startLat = coord2;
          let endLng = coord3;
          let endLat = coord4;

          // Validate coordinates are in reasonable range (lat/lng: -180 to 180, -90 to 90)
          if (
            Math.abs(startLng) <= 180 && Math.abs(startLat) <= 90 &&
            Math.abs(endLng) <= 180 && Math.abs(endLat) <= 90
          ) {
            const feature = turf.lineString(
              [[startLng, startLat], [endLng, endLat]],
              {
                id: lineId,
                type: lineType,
                source: 'imported'
              }
            );
            features.push(feature);
          }
        }
      } catch (err: any) {
        console.warn(`Error parsing line ${i}:`, err);
      }
    }

    console.log(`Parsed ${features.length} line features from CSV`);
    return features;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsProcessing(true);

    try {
      const newFiles: UploadedFile[] = [];
      let importedLines: Feature<LineString>[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const extension = file.name.split('.').pop()?.toLowerCase();

        try {
          const buffer = await file.arrayBuffer();
          let data: any = null;

          console.log(`Processing file: ${file.name} (${buffer.byteLength} bytes) extension: ${extension}`);

          if (extension === 'csv') {
            // Try to parse as line plan CSV
            const text = new TextDecoder().decode(buffer);
            const csvLines = parseLinePlanCSV(text);
            if (csvLines.length > 0) {
              importedLines = importedLines.concat(csvLines);
              console.log(`Imported ${csvLines.length} line features from CSV`);
              continue; // Skip normal processing for line plan CSVs
            }
          } else if (extension === 'kml') {
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
                throw new Error(`Unsupported file format: .${extension}. Please use .zip (Shapefile), .kml, .kmz, .csv, or .geojson`);
              }
              throw err;
            }
          }

          if (!data) {
            throw new Error("No data returned from file parser.");
          }

          // Standardize the output to a FeatureCollection
          let fileGeoJson: FeatureCollection;
          
          if (Array.isArray(data)) {
            // Combine all collections
            const allFeatures: Feature[] = [];
            data.forEach(item => {
              if (item.type === 'FeatureCollection') {
                allFeatures.push(...item.features);
              }
            });
            fileGeoJson = turf.featureCollection(allFeatures) as FeatureCollection;
          } else if (data.type === 'FeatureCollection') {
            fileGeoJson = data as FeatureCollection;
          } else if (data.type === 'Feature') {
            fileGeoJson = turf.featureCollection([data]) as FeatureCollection;
          } else {
            fileGeoJson = data as FeatureCollection;
          }

          // Extract LineStrings as imported line plans
          const lineFeatures = fileGeoJson.features.filter(
            f => f.geometry.type === 'LineString'
          ) as Feature<LineString>[];
          
          if (lineFeatures.length > 0) {
            // Mark as imported and add unique IDs
            lineFeatures.forEach((f, idx) => {
              if (!f.properties) f.properties = {};
              f.properties.source = 'imported';
              if (!f.id) f.id = `imported-line-${Date.now()}-${idx}`;
            });
            importedLines = importedLines.concat(lineFeatures);
            console.log(`Imported ${lineFeatures.length} line features from ${file.name}`);
          }

          // Extract polygons as boundaries
          const polygonFeatures = fileGeoJson.features.filter(
            f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'
          );
          
          if (polygonFeatures.length > 0) {
            const boundaryGeoJson = turf.featureCollection(polygonFeatures) as FeatureCollection;
            newFiles.push({
              id: `${Date.now()}-${i}`,
              name: file.name,
              geoJson: boundaryGeoJson
            });
          }

        } catch (err: any) {
          console.error(`Error processing ${file.name}:`, err);
          alert(`Error processing ${file.name}: ${err.message || String(err)}`);
        }
      }

      // Load imported lines
      if (importedLines.length > 0) {
        const inferred = inferSettingsFromImportedLines(importedLines);
        setImportedLineFeatures(importedLines);
        setImportedLinesFileName(files[0].name);
        setSettings(prev => ({
          ...prev,
          angle: inferred.angle,
          flightLineSpacing: inferred.flightLineSpacing ?? prev.flightLineSpacing,
          tieLineSpacing: inferred.tieLineSpacing ?? prev.tieLineSpacing
        }));

        alert(
          `Successfully imported ${importedLines.length} line feature(s). ` +
          `Detected angle: ${inferred.angle}deg, ` +
          `flight spacing: ${inferred.flightLineSpacing ?? 'n/a'}m, ` +
          `tie spacing: ${inferred.tieLineSpacing ?? 'n/a'}m.`
        );
      }

      // Load boundaries
      if (newFiles.length > 0) {
        setGeoJson(newFiles[0].geoJson);
        setFileName(newFiles[0].name);
      }

    } catch (err: any) {
      console.error("File upload error:", err);
      alert(`File upload error: ${err.message || String(err)}`);
    } finally {
      setIsProcessing(false);
      // Reset the input so same files can be uploaded again if removed
      e.target.value = '';
    }
  };

  const handleRemoveFile = (fileId: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const handleClearAll = () => {
    setUploadedFiles([]);
    setDeletedLineIds(new Set());
    setModifiedLines({});
    setSelectedLineId(null);
    setImportedLineFeatures([]);
    setImportedLinesFileName('');
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
    if (!allFlightLines || !allTieLines || !stats) return '';
    const baseName = fileName ? fileName.split('.')[0] : 'drone-plan';
    const timestamp = new Date().toISOString().split('T')[0];
    
    let csv = '';
    csv += '"LINE PLAN SUMMARY"\n';
    csv += '"Generated Date","' + timestamp + '"\n';
    csv += '"Project Name","' + baseName + '"\n';
        if (importedLinesFileName) {
          csv += '"Imported From","' + importedLinesFileName + '"\n';
        }
    csv += '\n';
    
    csv += '"MISSION SETTINGS"\n';
    csv += '"Flight Line Spacing (m)","' + settings.flightLineSpacing + '"\n';
    csv += '"Tie Line Spacing (m)","' + settings.tieLineSpacing + '"\n';
    csv += '"Flight Direction (deg)","' + settings.angle + '"\n';
    csv += '"Overlap (%)","' + settings.overlap + '"\n';
    csv += '"Swap Directions","' + (settings.swapDirections ? 'Yes' : 'No') + '"\n';
    csv += '"Grid Offset X (m)","' + settings.gridOffsetX + '"\n';
    csv += '"Grid Offset Y (m)","' + settings.gridOffsetY + '"\n';
    csv += '\n';
    
    csv += '"MISSION STATISTICS"\n';
    csv += '"Flight Lines","' + allFlightLines.features.length + '"\n';
    csv += '"Tie Lines","' + allTieLines.features.length + '"\n';
    csv += '"Total Lines","' + (allFlightLines.features.length + allTieLines.features.length) + '"\n';
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
    if (!allFlightLines || !allTieLines) return '';
    
    let csv = '';
    csv += '"Line ID","Type","Length (km)","Source","START","","END",""\n';
    csv += '"","","","","Longitude","Latitude","Longitude","Latitude"\n';
    
    allFlightLines.features.forEach((feature, idx) => {
      const coords = feature.geometry.coordinates;
      const lineLength = turf.length(feature, { units: 'kilometers' });
      const startLng = coords[0][0];
      const startLat = coords[0][1];
      const endLng = coords[coords.length - 1][0];
      const endLat = coords[coords.length - 1][1];
      const source = feature.properties?.source || 'generated';
      
      csv += `"FL-${idx + 1}","Flight Line","${lineLength.toFixed(4)}","${source}","${startLng.toFixed(6)}","${startLat.toFixed(6)}","${endLng.toFixed(6)}","${endLat.toFixed(6)}"\n`;
    });
    
    allTieLines.features.forEach((feature, idx) => {
      const coords = feature.geometry.coordinates;
      const lineLength = turf.length(feature, { units: 'kilometers' });
      const startLng = coords[0][0];
      const startLat = coords[0][1];
      const endLng = coords[coords.length - 1][0];
      const endLat = coords[coords.length - 1][1];
      const source = feature.properties?.source || 'generated';
      
      csv += `"TL-${idx + 1}","Tie Line","${lineLength.toFixed(4)}","${source}","${startLng.toFixed(6)}","${startLat.toFixed(6)}","${endLng.toFixed(6)}","${endLat.toFixed(6)}"\n`;
    });
    
    return csv;
  };

  const exportDgpsShapefile = async () => {
    if (!dgpsCandidates || dgpsCandidates.features.length === 0) {
      alert('No DGPS candidate points available to export.');
      return;
    }

    const baseName = fileName ? fileName.split('.')[0] : 'drone-plan';
    const dgpsCollection = turf.featureCollection(
      dgpsCandidates.features.map((feature, index) => ({
        type: 'Feature' as const,
        geometry: feature.geometry,
        properties: {
          id: String(feature.properties?.candidateId ?? `DGPS-${index + 1}`),
          rank: Number(feature.properties?.rank ?? index + 1),
          score: Number(feature.properties?.score ?? 0),
          ndvi: Number(feature.properties?.ndvi ?? 0),
          ndbi: Number(feature.properties?.ndbi ?? 0),
          elev_m: Number(feature.properties?.elevationM ?? 0),
          slope_d: Number(feature.properties?.slopeDeg ?? 0),
          source: String(feature.properties?.source ?? 'generated'),
          valid: String(dgpsValidationRecords[String(feature.properties?.candidateId ?? '')]?.label ?? 'unlabeled')
        }
      }))
    );

    const shpZip = shpwrite.zip(dgpsCollection, {
      folder: `${baseName}-dgps-candidates`,
      filename: `${baseName}-dgps-candidates`
    });

    const shpBlob = shpZip instanceof Blob
      ? shpZip
      : new Blob([shpZip as ArrayBuffer | Uint8Array], { type: 'application/zip' });

    downloadBlob(shpBlob, `${baseName}-dgps-candidates.zip`);
  };

  const handleExport = async () => {
    if (!allFlightLines || !allTieLines) return;
    const baseName = fileName ? fileName.split('.')[0] : 'drone-plan';
    const sanitizeForFileName = (value: string) => value
      .trim()
      .replace(/[<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    const preflightPrefix = sanitizeForFileName(preflightFilePrefix) || sanitizeForFileName(baseName) || 'drone-plan';
    const sequentialName = (index: number) => {
      const trailingNumberMatch = preflightPrefix.match(/^(.*?)(\d+)$/);
      if (trailingNumberMatch) {
        const stem = trailingNumberMatch[1];
        const numberPart = trailingNumberMatch[2];
        const nextValue = Number(numberPart) + index;
        return `${stem}${String(nextValue).padStart(numberPart.length, '0')}`;
      }

      const sequence = String(index + 1).padStart(3, '0');
      return `${preflightPrefix}-${sequence}`;
    };
    
    if (exportFormat === 'dgps-shp') {
      await exportDgpsShapefile();
      return;
    }

    if (exportFormat === 'csv') {
      // Generate both CSV files and zip them together
      const summaryCSV = generateSummaryCSV();
      const lineDetailsCSV = generateLineDetailsCSV();
      
      const zip = new JSZip();
      zip.file(`${baseName}-summary.csv`, summaryCSV);
      zip.file(`${baseName}-line-details.csv`, lineDetailsCSV);
      
      const content = await zip.generateAsync({ type: "blob" });
      downloadBlob(content, `${baseName}-plan.zip`);
    } else if (exportFormat === 'preflight-kml' || exportFormat === 'preflight-kmz') {
      const zip = new JSZip();
      const lineExtension = exportFormat === 'preflight-kml' ? 'kml' : 'kmz';
      let lineSequenceIndex = 0;

      for (let i = 0; i < allFlightLines.features.length; i++) {
        const feature = allFlightLines.features[i];
        const lineFeature = {
          ...feature,
          properties: {
            type: 'Flight Line',
            category: 'flight-line',
            lineNumber: i + 1,
            name: `Flight Line ${i + 1}`,
            stroke: settings.flightLineColor,
            'stroke-width': 3,
            'stroke-opacity': 1
          }
        };

        const lineFileName = sequentialName(lineSequenceIndex);
        const lineKml = generateKMLWithStyles(turf.featureCollection([lineFeature]), lineFileName);
        lineSequenceIndex += 1;

        if (exportFormat === 'preflight-kml') {
          zip.file(`${lineFileName}.kml`, lineKml);
        } else {
          const singleKmz = new JSZip();
          singleKmz.file('doc.kml', lineKml);
          const kmzBuffer = await singleKmz.generateAsync({ type: 'uint8array' });
          zip.file(`${lineFileName}.kmz`, kmzBuffer);
        }
      }

      for (let i = 0; i < allTieLines.features.length; i++) {
        const feature = allTieLines.features[i];
        const lineFeature = {
          ...feature,
          properties: {
            type: 'Tie Line',
            category: 'tie-line',
            lineNumber: i + 1,
            name: `Tie Line ${i + 1}`,
            stroke: settings.tieLineColor,
            'stroke-width': 1.5,
            'stroke-opacity': 0.8,
            'stroke-dasharray': '4, 4'
          }
        };

        const lineFileName = sequentialName(lineSequenceIndex);
        const lineKml = generateKMLWithStyles(turf.featureCollection([lineFeature]), lineFileName);
        lineSequenceIndex += 1;

        if (exportFormat === 'preflight-kml') {
          zip.file(`${lineFileName}.kml`, lineKml);
        } else {
          const singleKmz = new JSZip();
          singleKmz.file('doc.kml', lineKml);
          const kmzBuffer = await singleKmz.generateAsync({ type: 'uint8array' });
          zip.file(`${lineFileName}.kmz`, kmzBuffer);
        }
      }

      const content = await zip.generateAsync({ type: 'blob' });
      downloadBlob(content, `${preflightPrefix}-pre-flight-lines-${lineExtension}.zip`);
    } else {
      const combined = getCombinedGeoJSON();
      
      if (exportFormat === 'geojson') {
        const blob = new Blob([JSON.stringify(combined)], { type: 'application/json' });
        downloadBlob(blob, `${baseName}-plan.geojson`);
      } else if (exportFormat === 'kml') {
        const kmlContent = generateKMLWithStyles(combined, baseName);
        const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml' });
        downloadBlob(blob, `${baseName}-plan.kml`);
      } else if (exportFormat === 'kmz') {
        const kmlContent = generateKMLWithStyles(combined, baseName);
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
    if (!allFlightLines || !allTieLines) return turf.featureCollection([]);
    const features = [
      ...allFlightLines.features.map((f, idx) => ({ 
        ...f, 
        properties: { 
          type: 'Flight Line',
          category: 'flight-line',
          lineNumber: idx + 1,
          name: `Flight Line ${idx + 1}`,
          stroke: settings.flightLineColor,
          'stroke-width': 3,
          'stroke-opacity': 1,
          source: f.properties?.source || 'generated'
        } 
      })),
      ...allTieLines.features.map((f, idx) => ({ 
        ...f, 
        properties: { 
          type: 'Tie Line',
          category: 'tie-line',
          lineNumber: idx + 1,
          name: `Tie Line ${idx + 1}`,
          stroke: settings.tieLineColor,
          'stroke-width': 1.5,
          'stroke-opacity': 0.8,
          'stroke-dasharray': '4, 4',
          source: f.properties?.source || 'generated'
        } 
      }))
    ];
    // Add boundary with proper styling
    if (mainPolygon) {
      features.push({ 
        ...mainPolygon, 
        properties: { 
          type: 'Boundary',
          category: 'boundary',
          name: 'Survey Boundary',
          stroke: settings.boundaryColor,
          'stroke-width': 2,
          'stroke-opacity': 1,
          fill: settings.boundaryColor,
          'fill-opacity': 0.1
        } 
      });
    }
    return turf.featureCollection(features);
  };

  const generateKMLWithStyles = (geoJsonData: FeatureCollection, documentName?: string) => {
    // Helper to convert hex color to KML color (aabbggrr format)
    const hexToKmlColor = (hex: string, opacity: number = 1) => {
      const alpha = Math.floor(opacity * 255).toString(16).padStart(2, '0');
      const rgb = hex.replace('#', '');
      const r = rgb.substring(0, 2);
      const g = rgb.substring(2, 4);
      const b = rgb.substring(4, 6);
      return `${alpha}${b}${g}${r}`;
    };

    // Fixed colors for KML export (Google Earth display)
    const flightLineColor = '#40E0D0'; // Turquoise blue
    const tieLineColor = '#FFFF00';    // Yellow
    const boundaryColor = '#FF0000';   // Red

    // KML header with styles
    let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
    kml += '<Document>\n';
    kml += `  <name>${documentName || 'Drone Line Plan'}</name>\n`;
    kml += '  <description>Generated by Austhai UAV Line Planner</description>\n\n';

    // Define styles for each line type with fixed colors
    kml += '  <Style id="flightLineStyle">\n';
    kml += '    <LineStyle>\n';
    kml += `      <color>${hexToKmlColor(flightLineColor, 1)}</color>\n`;
    kml += '      <width>1.5</width>\n';
    kml += '    </LineStyle>\n';
    kml += '  </Style>\n\n';

    kml += '  <Style id="tieLineStyle">\n';
    kml += '    <LineStyle>\n';
    kml += `      <color>${hexToKmlColor(tieLineColor, 1)}</color>\n`;
    kml += '      <width>2.5</width>\n';
    kml += '    </LineStyle>\n';
    kml += '  </Style>\n\n';

    kml += '  <Style id="boundaryStyle">\n';
    kml += '    <LineStyle>\n';
    kml += `      <color>${hexToKmlColor(boundaryColor, 1)}</color>\n`;
    kml += '      <width>3</width>\n';
    kml += '    </LineStyle>\n';
    kml += '    <PolyStyle>\n';
    kml += `      <color>${hexToKmlColor(boundaryColor, 0.15)}</color>\n`;
    kml += '      <fill>1</fill>\n';
    kml += '      <outline>1</outline>\n';
    kml += '    </PolyStyle>\n';
    kml += '  </Style>\n\n';

    // Create folders for organization
    const flightLineFeatures = geoJsonData.features.filter(f => f.properties?.category === 'flight-line');
    const tieLineFeatures = geoJsonData.features.filter(f => f.properties?.category === 'tie-line');
    const boundaryFeatures = geoJsonData.features.filter(f => f.properties?.category === 'boundary');

    // Flight Lines Folder
    if (flightLineFeatures.length > 0) {
      kml += '  <Folder>\n';
      kml += '    <name>Flight Lines</name>\n';
      flightLineFeatures.forEach(feature => {
        kml += '    <Placemark>\n';
        kml += `      <name>${feature.properties?.name || 'Flight Line'}</name>\n`;
        kml += '      <styleUrl>#flightLineStyle</styleUrl>\n';
        kml += '      <ExtendedData>\n';
        kml += `        <Data name="Type"><value>${feature.properties?.type || ''}</value></Data>\n`;
        kml += `        <Data name="Line Number"><value>${feature.properties?.lineNumber || ''}</value></Data>\n`;
        kml += '      </ExtendedData>\n';
        if (feature.geometry.type === 'LineString') {
          kml += '      <LineString>\n';
          kml += '        <coordinates>\n';
          feature.geometry.coordinates.forEach((coord: number[]) => {
            kml += `          ${coord[0]},${coord[1]},0\n`;
          });
          kml += '        </coordinates>\n';
          kml += '      </LineString>\n';
        }
        kml += '    </Placemark>\n';
      });
      kml += '  </Folder>\n\n';
    }

    // Tie Lines Folder
    if (tieLineFeatures.length > 0) {
      kml += '  <Folder>\n';
      kml += '    <name>Tie Lines</name>\n';
      tieLineFeatures.forEach(feature => {
        kml += '    <Placemark>\n';
        kml += `      <name>${feature.properties?.name || 'Tie Line'}</name>\n`;
        kml += '      <styleUrl>#tieLineStyle</styleUrl>\n';
        kml += '      <ExtendedData>\n';
        kml += `        <Data name="Type"><value>${feature.properties?.type || ''}</value></Data>\n`;
        kml += `        <Data name="Line Number"><value>${feature.properties?.lineNumber || ''}</value></Data>\n`;
        kml += '      </ExtendedData>\n';
        if (feature.geometry.type === 'LineString') {
          kml += '      <LineString>\n';
          kml += '        <coordinates>\n';
          feature.geometry.coordinates.forEach((coord: number[]) => {
            kml += `          ${coord[0]},${coord[1]},0\n`;
          });
          kml += '        </coordinates>\n';
          kml += '      </LineString>\n';
        }
        kml += '    </Placemark>\n';
      });
      kml += '  </Folder>\n\n';
    }

    // Boundary Folder
    if (boundaryFeatures.length > 0) {
      kml += '  <Folder>\n';
      kml += '    <name>Survey Boundary</name>\n';
      boundaryFeatures.forEach(feature => {
        kml += '    <Placemark>\n';
        kml += `      <name>${feature.properties?.name || 'Boundary'}</name>\n`;
        kml += '      <styleUrl>#boundaryStyle</styleUrl>\n';
        kml += '      <ExtendedData>\n';
        kml += `        <Data name="Type"><value>${feature.properties?.type || ''}</value></Data>\n`;
        kml += '      </ExtendedData>\n';
        if (feature.geometry.type === 'Polygon') {
          kml += '      <Polygon>\n';
          kml += '        <outerBoundaryIs>\n';
          kml += '          <LinearRing>\n';
          kml += '            <coordinates>\n';
          feature.geometry.coordinates[0].forEach((coord: number[]) => {
            kml += `              ${coord[0]},${coord[1]},0\n`;
          });
          kml += '            </coordinates>\n';
          kml += '          </LinearRing>\n';
          kml += '        </outerBoundaryIs>\n';
          kml += '      </Polygon>\n';
        } else if (feature.geometry.type === 'MultiPolygon') {
          feature.geometry.coordinates.forEach((polygon: number[][][]) => {
            kml += '      <Polygon>\n';
            kml += '        <outerBoundaryIs>\n';
            kml += '          <LinearRing>\n';
            kml += '            <coordinates>\n';
            polygon[0].forEach((coord: number[]) => {
              kml += `              ${coord[0]},${coord[1]},0\n`;
            });
            kml += '            </coordinates>\n';
            kml += '          </LinearRing>\n';
            kml += '        </outerBoundaryIs>\n';
            kml += '      </Polygon>\n';
          });
        }
        kml += '    </Placemark>\n';
      });
      kml += '  </Folder>\n\n';
    }

    kml += '</Document>\n';
    kml += '</kml>';
    
    return kml;
  };

  // Utility functions for new features
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      alert('Coordinates copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  };

  const calculateMeasurementDistance = () => {
    if (measurementPoints.length < 2) return 0;
    const line = turf.lineString(measurementPoints);
    return turf.length(line, { units: 'meters' });
  };

  const calculateMeasurementArea = () => {
    if (measurementPoints.length < 3) return 0;
    try {
      const polygon = turf.polygon([[...measurementPoints, measurementPoints[0]]]);
      return turf.area(polygon);
    } catch {
      return 0;
    }
  };

  const handleMapClick = (e: L.LeafletMouseEvent) => {
    if (dgpsEditMode === 'add') {
      if (!mainPolygon) return;

      const clickPoint = turf.point([e.latlng.lng, e.latlng.lat]);
      if (!turf.booleanPointInPolygon(clickPoint, mainPolygon)) {
        return;
      }

      const manualCandidateId = `DGPS-M-${Date.now()}`;
      const manualPoint = turf.point([e.latlng.lng, e.latlng.lat], {
        candidateId: manualCandidateId,
        source: 'manual',
        score: 100,
        ndvi: 0,
        ndbi: 0,
        elevationM: 0,
        slopeDeg: 0,
        rank: (dgpsCandidates?.features.length ?? 0) + 1
      });

      setManualDgpsPoints(prev => [...prev, manualPoint]);
      setDgpsEditHistory(prev => [...prev, {
        type: 'add-manual',
        candidateId: manualCandidateId,
        candidate: manualPoint
      }]);
      return;
    }

    if (measurementMode === 'distance' || measurementMode === 'area') {
      setMeasurementPoints(prev => [...prev, [e.latlng.lng, e.latlng.lat]]);
    } else if (isAddingNote) {
      setEditingNote({
        lat: e.latlng.lat,
        lng: e.latlng.lng,
        currentValue: ''
      });
      setIsAddingNote(false);
    } else if (homePoint === null && e.originalEvent.ctrlKey) {
      // Ctrl+Click to set home point
      setHomePoint({ lat: e.latlng.lat, lng: e.latlng.lng });
    }
  };

  const undoLastDgpsEdit = () => {
    setDgpsEditHistory(prev => {
      if (prev.length === 0) return prev;

      const next = [...prev];
      const lastAction = next.pop();
      if (!lastAction) return prev;

      if (lastAction.type === 'add-manual') {
        setManualDgpsPoints(points => points.filter(
          p => String(p.properties?.candidateId) !== lastAction.candidateId
        ));
      } else if (lastAction.type === 'remove-manual') {
        setManualDgpsPoints(points => [...points, lastAction.candidate]);
      } else if (lastAction.type === 'remove-generated') {
        setRemovedGeneratedCandidateIds(ids => {
          const cloned = new Set(ids);
          cloned.delete(lastAction.candidateId);
          return cloned;
        });
      }

      return next;
    });
  };

  const labelSelectedDgpsCandidate = (label: 'accepted' | 'rejected') => {
    if (!selectedDgpsCandidate) return;

    const candidateId = String(selectedDgpsCandidate.properties?.candidateId ?? '');
    const score = Number(selectedDgpsCandidate.properties?.score ?? 0);
    const source = String(selectedDgpsCandidate.properties?.source ?? 'generated');

    setDgpsValidationRecords(prev => ({
      ...prev,
      [candidateId]: {
        candidateId,
        score,
        label,
        source,
        timestamp: Date.now()
      }
    }));
  };

  const clearDgpsValidationData = () => {
    setDgpsValidationRecords({});
  };

  const clearMeasurement = () => {
    setMeasurementPoints([]);
    setMeasurementMode('off');
  };

  const toggleLineProgress = (lineId: string) => {
    setLineProgress(prev => {
      const current = prev[lineId] || 'pending';
      const next = current === 'pending' ? 'in-progress' : current === 'in-progress' ? 'completed' : 'pending';
      return { ...prev, [lineId]: next };
    });
  };

  const getProgressColor = (lineId: string) => {
    const status = lineProgress[lineId] || 'pending';
    return status === 'completed' ? '#10b981' : status === 'in-progress' ? '#f59e0b' : undefined;
  };

  const combinedGeoJSON = useMemo(() => getCombinedGeoJSON(), [flightLines, tieLines, mainPolygon, settings]);

  // Save dark mode preference
  useEffect(() => {
    localStorage.setItem('darkMode', JSON.stringify(darkMode));
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  return (
    <div className={cn(
      "flex h-screen w-full overflow-hidden",
      darkMode ? "bg-slate-900 text-slate-100" : "bg-white text-slate-900"
    )}>
      {/* Edit Label Modal */}
      <AnimatePresence>
        {editingLabel && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setEditingLabel(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 tracking-tight">Edit Label</h2>
                  <p className="text-xs text-slate-400 font-mono uppercase tracking-widest">
                    {editingLabel.lineId} - {editingLabel.position === 'start' ? 'Start Point' : 'End Point'}
                  </p>
                </div>
                <button 
                  onClick={() => setEditingLabel(null)}
                  className="p-2 hover:bg-slate-50 rounded-full text-slate-400 hover:text-slate-900 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Label Text</label>
                  <input
                    type="text"
                    autoFocus
                    defaultValue={editingLabel.currentValue}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const input = e.currentTarget;
                        const newValue = input.value.trim();
                        if (newValue) {
                          setLineLabels(prev => ({
                            ...prev,
                            [editingLabel.lineId]: {
                              ...prev[editingLabel.lineId],
                              [editingLabel.position]: newValue
                            }
                          }));
                          setEditingLabel(null);
                        }
                      } else if (e.key === 'Escape') {
                        setEditingLabel(null);
                      }
                    }}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                    placeholder="Enter label text"
                  />
                </div>
              </div>

              <div className="p-6 border-t border-slate-100 bg-slate-50 flex gap-3">
                <button 
                  onClick={() => setEditingLabel(null)}
                  className="flex-1 px-6 py-3 rounded-xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-100 transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    const input = document.querySelector<HTMLInputElement>('.fixed input[type="text"]');
                    const newValue = input?.value.trim();
                    if (newValue) {
                      setLineLabels(prev => ({
                        ...prev,
                        [editingLabel.lineId]: {
                          ...prev[editingLabel.lineId],
                          [editingLabel.position]: newValue
                        }
                      }));
                      setEditingLabel(null);
                    }
                  }}
                  className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-blue-600/10"
                >
                  Save Label
                </button>
              </div>
            </motion.div>
          </div>
        )}

                  {/* Imported Line Plans Indicator */}
                  {importedLineFeatures.length > 0 && (
                    <div className={cn(
                      "rounded-lg p-3 border mt-3",
                      darkMode ? "bg-emerald-900/20 border-emerald-800/50" : "bg-emerald-50 border-emerald-100"
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Activity className="w-4 h-4 text-emerald-600 shrink-0" />
                          <div>
                            <p className={cn(
                              "text-xs font-medium",
                              darkMode ? "text-emerald-400" : "text-emerald-900"
                            )}>Imported Line Plan</p>
                            <p className={cn(
                              "text-[10px] font-mono",
                              darkMode ? "text-emerald-400" : "text-emerald-600"
                            )}>{importedLineFeatures.length} line{importedLineFeatures.length !== 1 ? 's' : ''} from {importedLinesFileName}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setImportedLineFeatures([]);
                            setImportedLinesFileName('');
                          }}
                          className={cn(
                            "p-1.5 rounded transition-colors",
                            darkMode 
                              ? "hover:bg-red-900/20 text-slate-400 hover:text-red-400" 
                              : "hover:bg-red-50 text-slate-300 hover:text-red-500"
                          )}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
      </AnimatePresence>

      {/* Edit Note Modal */}
      <AnimatePresence>
        {editingNote && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setEditingNote(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 tracking-tight">Add Note</h2>
                  <p className="text-xs text-slate-400 font-mono uppercase tracking-widest">
                    Map Annotation
                  </p>
                </div>
                <button 
                  onClick={() => setEditingNote(null)}
                  className="p-2 hover:bg-slate-50 rounded-full text-slate-400 hover:text-slate-900 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Note Text</label>
                  <textarea
                    autoFocus
                    rows={4}
                    defaultValue={editingNote.currentValue}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        const textarea = e.currentTarget;
                        const newValue = textarea.value.trim();
                        if (newValue) {
                          setNotes(prev => [...prev, {
                            id: `note-${Date.now()}`,
                            lat: editingNote.lat,
                            lng: editingNote.lng,
                            text: newValue
                          }]);
                          setEditingNote(null);
                        }
                      } else if (e.key === 'Escape') {
                        setEditingNote(null);
                      }
                    }}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm resize-none"
                    placeholder="Enter note text (Ctrl+Enter to save)"
                  />
                </div>
              </div>

              <div className="p-6 border-t border-slate-100 bg-slate-50 flex gap-3">
                <button 
                  onClick={() => setEditingNote(null)}
                  className="flex-1 px-6 py-3 rounded-xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-100 transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    const textarea = document.querySelector<HTMLTextAreaElement>('.fixed textarea');
                    const newValue = textarea?.value.trim();
                    if (newValue) {
                      setNotes(prev => [...prev, {
                        id: `note-${Date.now()}`,
                        lat: editingNote.lat,
                        lng: editingNote.lng,
                        text: newValue
                      }]);
                      setEditingNote(null);
                    }
                  }}
                  className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-blue-600/10"
                >
                  Add Note
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={cn(
        "w-80 flex flex-col border-r z-20",
        darkMode ? "bg-slate-800 text-slate-100 border-slate-700" : "bg-white text-slate-900 border-slate-200"
      )}>
        <div className={cn(
          "p-6 border-b flex flex-col gap-4",
          darkMode ? "border-slate-700" : "border-slate-100"
        )}>
          <Logo className="mb-4" />
          <div className="text-center">
            <div className="flex items-center justify-center gap-2 mb-1">
              <h1 className={cn(
                "text-lg font-semibold tracking-tight",
                darkMode ? "text-slate-100" : "text-slate-900"
              )}>Austhai UAV <span className="italic font-serif opacity-50 text-sm">Line planner</span></h1>
            </div>
            <p className="text-[9px] text-slate-400 font-medium -mt-1 mb-2">created by Ray Emmanuel B. Diaz</p>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">v1.0.0</p>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={cn(
                "mt-3 w-full py-2 rounded-lg flex items-center justify-center gap-2 transition-all text-xs font-medium",
                darkMode 
                  ? "bg-slate-700 hover:bg-slate-600 text-slate-100" 
                  : "bg-slate-100 hover:bg-slate-200 text-slate-900"
              )}
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              {darkMode ? 'Light Mode' : 'Dark Mode'}
            </button>
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
          <section className={cn(
            "border rounded-xl p-4",
            darkMode ? "bg-blue-900/20 border-blue-800/50" : "bg-blue-50 border-blue-100"
          )}>
            <div className="flex gap-3">
              <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className={cn(
                  "text-[11px] leading-relaxed",
                  darkMode ? "text-blue-400/80" : "text-blue-600/80"
                )}>
                  Supports <span className={cn("font-bold", darkMode ? "text-blue-400" : "text-blue-600")}>KML, KMZ, GeoJSON</span> and <span className={cn("font-bold", darkMode ? "text-blue-400" : "text-blue-600")}>Zipped Shapefiles</span> (.shp, .shx, .dbf).
                </p>
                <p className={cn(
                  "text-[10px] leading-relaxed",
                  darkMode ? "text-blue-400/60" : "text-blue-600/60"
                )}>
                  Upload multiple files to automatically merge areas for unified line planning.
                </p>
              </div>
            </div>
          </section>

          {/* Upload Section */}
          <section>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-3 font-mono">1. Area of Interest</label>
            
            {/* Upload Button */}
            <label className={cn(
              "flex flex-col items-center justify-center w-full h-24 border-2 border-dashed rounded-xl cursor-pointer transition-all group mb-3",
              darkMode 
                ? "border-slate-700 hover:border-blue-500/50 hover:bg-slate-700/50" 
                : "border-slate-200 hover:border-blue-400/50 hover:bg-slate-50"
            )}>
              <Upload className={cn(
                "w-6 h-6 transition-colors mb-1",
                darkMode ? "text-slate-600 group-hover:text-blue-400" : "text-slate-300 group-hover:text-blue-600"
              )} />
              <span className={cn(
                "text-xs text-center px-4",
                darkMode ? "text-slate-400 group-hover:text-slate-300" : "text-slate-400 group-hover:text-slate-600"
              )}>
                Upload File
              </span>
              <span className="text-[10px] text-slate-300 mt-0.5">KML, KMZ, GeoJSON or Shapefile</span>
              <input 
                type="file" 
                className="hidden" 
                accept=".zip,.kml,.kmz,.json,.geojson,.csv" 
                onChange={handleFileUpload} 
                multiple 
              />
            </label>

            {/* Uploaded Files List */}
            {uploadedFiles.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">
                    {uploadedFiles.length} file{uploadedFiles.length !== 1 ? 's' : ''} uploaded
                  </span>
                  {uploadedFiles.length > 1 && (
                    <button 
                      onClick={handleClearAll}
                      className="text-[9px] text-red-500 hover:text-red-600 uppercase tracking-wider font-bold transition-colors"
                    >
                      Clear All
                    </button>
                  )}
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {uploadedFiles.map(file => (
                    <div key={file.id} className={cn(
                      "rounded-lg p-3 border flex items-center justify-between group transition-all",
                      darkMode 
                        ? "bg-slate-700 border-slate-600 hover:border-slate-500" 
                        : "bg-slate-50 border-slate-100 hover:border-slate-200"
                    )}>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className={cn(
                          "w-6 h-6 rounded flex items-center justify-center shrink-0",
                          darkMode ? "bg-blue-900/50" : "bg-blue-100"
                        )}>
                          <MapIcon className="w-3 h-3 text-blue-600" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={cn(
                            "text-xs font-medium truncate",
                            darkMode ? "text-slate-200" : "text-slate-900"
                          )}>{file.name}</p>
                          <p className="text-[9px] text-slate-400">
                            {file.geoJson.features.length} feature{file.geoJson.features.length !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>
                      <button 
                        onClick={() => handleRemoveFile(file.id)}
                        className={cn(
                          "p-1.5 rounded transition-colors opacity-0 group-hover:opacity-100",
                          darkMode 
                            ? "hover:bg-red-900/20 text-slate-400 hover:text-red-400" 
                            : "hover:bg-red-50 text-slate-300 hover:text-red-500"
                        )}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                
                {/* Merged Area Info */}
                {geoJson && stats && (
                  <div className={cn(
                    "rounded-lg p-3 border mt-3",
                    darkMode ? "bg-blue-900/20 border-blue-800/50" : "bg-blue-50 border-blue-100"
                  )}>
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-blue-600 shrink-0" />
                      <div>
                        <p className={cn(
                          "text-xs font-medium",
                          darkMode ? "text-blue-400" : "text-blue-900"
                        )}>Merged Area</p>
                        <p className={cn(
                          "text-[10px] font-mono",
                          darkMode ? "text-blue-400" : "text-blue-600"
                        )}>{stats?.area} km²</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Settings Section */}
          <section className={cn("space-y-4 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 mb-3 font-mono">2. Path Parameters</label>
            
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <label className={cn("text-xs", darkMode ? "text-slate-300" : "text-slate-600")}>Flight Line Spacing (m)</label>
                  <input 
                    type="number"
                    value={settings.flightLineSpacing}
                    onChange={(e) => setSettings(s => ({ ...s, flightLineSpacing: Number(e.target.value) }))}
                    className={cn(
                      "w-16 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-blue-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-blue-400" : "bg-slate-50 border-slate-200 text-blue-600"
                    )}
                  />
                </div>
                <input 
                  type="range" min="1" max="500" step="1"
                  value={settings.flightLineSpacing}
                  onChange={(e) => setSettings(s => ({ ...s, flightLineSpacing: Number(e.target.value) }))}
                  className={cn(
                    "w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-blue-600",
                    darkMode ? "bg-slate-700" : "bg-slate-100"
                  )}
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className={cn("text-xs", darkMode ? "text-slate-300" : "text-slate-600")}>Tie Line Spacing (m)</label>
                  <input 
                    type="number"
                    value={settings.tieLineSpacing}
                    onChange={(e) => setSettings(s => ({ ...s, tieLineSpacing: Number(e.target.value) }))}
                    className={cn(
                      "w-16 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-blue-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-blue-400" : "bg-slate-50 border-slate-200 text-blue-600"
                    )}
                  />
                </div>
                <input 
                  type="range" min="0" max="1000" step="1"
                  value={settings.tieLineSpacing}
                  onChange={(e) => setSettings(s => ({ ...s, tieLineSpacing: Number(e.target.value) }))}
                  className={cn(
                    "w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-blue-600",
                    darkMode ? "bg-slate-700" : "bg-slate-100"
                  )}
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className={cn("text-xs", darkMode ? "text-slate-300" : "text-slate-600")}>Orientation Angle (°)</label>
                  <input 
                    type="number"
                    value={settings.angle}
                    onChange={(e) => setSettings(s => ({ ...s, angle: Number(e.target.value) }))}
                    className={cn(
                      "w-16 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-blue-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-blue-400" : "bg-slate-50 border-slate-200 text-blue-600"
                    )}
                  />
                </div>
                <div className="flex gap-3 items-center">
                  <input 
                    type="range" min="0" max="360" step="1"
                    value={settings.angle}
                    onChange={(e) => setSettings(s => ({ ...s, angle: Number(e.target.value) }))}
                    className={cn(
                      "flex-1 h-1.5 rounded-lg appearance-none cursor-pointer accent-blue-600",
                      darkMode ? "bg-slate-700" : "bg-slate-100"
                    )}
                  />
                  <button 
                    onClick={() => setSettings(s => ({ ...s, swapDirections: !s.swapDirections }))}
                    title="Swap Flight/Tie Directions"
                    className={cn(
                      "p-2 rounded-lg border transition-all",
                      settings.swapDirections 
                        ? "bg-blue-500/20 border-blue-500/40 text-blue-600" 
                        : darkMode
                          ? "bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200 hover:bg-slate-600"
                          : "bg-slate-50 border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-slate-100"
                    )}
                  >
                    <ArrowLeftRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1 uppercase font-mono">Grid Offset X (m)</label>
                  <input 
                    type="number"
                    value={settings.gridOffsetX}
                    onChange={(e) => setSettings(s => ({ ...s, gridOffsetX: Number(e.target.value) }))}
                    className={cn(
                      "w-full border rounded px-2 py-1 text-xs font-mono focus:border-blue-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-blue-400" : "bg-slate-50 border-slate-200 text-blue-600"
                    )}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1 uppercase font-mono">Grid Offset Y (m)</label>
                  <input 
                    type="number"
                    value={settings.gridOffsetY}
                    onChange={(e) => setSettings(s => ({ ...s, gridOffsetY: Number(e.target.value) }))}
                    className={cn(
                      "w-full border rounded px-2 py-1 text-xs font-mono focus:border-blue-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-blue-400" : "bg-slate-50 border-slate-200 text-blue-600"
                    )}
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
              <label className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50 transition-colors">
                <input 
                  type="checkbox" 
                  checked={showLineLabels}
                  onChange={(e) => setShowLineLabels(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 cursor-pointer"
                />
                <span className="text-xs text-slate-600 flex-1">Show Line Labels</span>
                <MapPin className="w-3 h-3 text-slate-400" />
              </label>
              <label className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50 transition-colors">
                <input
                  type="checkbox"
                  checked={showDgpsCandidates}
                  onChange={(e) => setShowDgpsCandidates(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 cursor-pointer"
                />
                <span className="text-xs text-slate-600 flex-1">Show DGPS Candidates</span>
                <div className="w-3 h-3 rounded-full bg-emerald-500" />
              </label>
              {Object.keys(lineLabels).length > 0 && (
                <div className="px-2">
                  <button
                    onClick={() => setLineLabels({})}
                    className="text-[9px] text-red-500 hover:text-red-600 uppercase tracking-wider font-bold transition-colors"
                  >
                    Reset All Labels
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* DGPS Threshold Controls */}
          <section className={cn("space-y-3 pt-4 border-t border-slate-100 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono">DGPS Site Filters</label>

            <div className={cn(
              "rounded-lg p-3 border space-y-3",
              darkMode ? "bg-emerald-900/20 border-emerald-800/50" : "bg-emerald-50/70 border-emerald-100"
            )}>
              <p className={cn(
                "text-[10px] leading-relaxed",
                darkMode ? "text-emerald-300/80" : "text-emerald-800/80"
              )}>
                Manually tune thresholds for bare-ground DGPS candidate filtering.
              </p>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={cn("text-[11px]", darkMode ? "text-slate-200" : "text-slate-700")}>Max Candidates</label>
                  <input
                    type="number"
                    min={5}
                    max={500}
                    step={1}
                    value={dgpsMaxCandidates}
                    onChange={(e) => setDgpsMaxCandidates(Math.max(5, Math.min(500, Number(e.target.value) || 5)))}
                    className={cn(
                      "w-20 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-emerald-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-emerald-300" : "bg-white border-slate-200 text-emerald-700"
                    )}
                  />
                </div>
                <input
                  type="range"
                  min="5"
                  max="500"
                  step="1"
                  value={dgpsMaxCandidates}
                  onChange={(e) => setDgpsMaxCandidates(Number(e.target.value))}
                  className={cn(
                    "w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-emerald-600",
                    darkMode ? "bg-slate-700" : "bg-slate-100"
                  )}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={cn("text-[11px]", darkMode ? "text-slate-200" : "text-slate-700")}>NDVI Max</label>
                  <input
                    type="number"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={dgpsThresholds.ndviMax}
                    onChange={(e) => setDgpsThresholds(prev => ({ ...prev, ndviMax: Number(e.target.value) }))}
                    className={cn(
                      "w-20 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-emerald-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-emerald-300" : "bg-white border-slate-200 text-emerald-700"
                    )}
                  />
                </div>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={dgpsThresholds.ndviMax}
                  onChange={(e) => setDgpsThresholds(prev => ({ ...prev, ndviMax: Number(e.target.value) }))}
                  className={cn(
                    "w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-emerald-600",
                    darkMode ? "bg-slate-700" : "bg-slate-100"
                  )}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={cn("text-[11px]", darkMode ? "text-slate-200" : "text-slate-700")}>NDBI Min</label>
                  <input
                    type="number"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={dgpsThresholds.ndbiMin}
                    onChange={(e) => setDgpsThresholds(prev => ({ ...prev, ndbiMin: Number(e.target.value) }))}
                    className={cn(
                      "w-20 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-emerald-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-emerald-300" : "bg-white border-slate-200 text-emerald-700"
                    )}
                  />
                </div>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={dgpsThresholds.ndbiMin}
                  onChange={(e) => setDgpsThresholds(prev => ({ ...prev, ndbiMin: Number(e.target.value) }))}
                  className={cn(
                    "w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-emerald-600",
                    darkMode ? "bg-slate-700" : "bg-slate-100"
                  )}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={cn("text-[11px]", darkMode ? "text-slate-200" : "text-slate-700")}>Elevation Min (m)</label>
                  <input
                    type="number"
                    min={0}
                    max={9000}
                    step={10}
                    value={dgpsThresholds.minElevation}
                    onChange={(e) => setDgpsThresholds(prev => ({ ...prev, minElevation: Number(e.target.value) }))}
                    className={cn(
                      "w-20 border rounded px-1.5 py-0.5 text-xs font-mono text-right focus:border-emerald-500/50 outline-none",
                      darkMode ? "bg-slate-700 border-slate-600 text-emerald-300" : "bg-white border-slate-200 text-emerald-700"
                    )}
                  />
                </div>
                <input
                  type="range"
                  min="0"
                  max="9000"
                  step="10"
                  value={dgpsThresholds.minElevation}
                  onChange={(e) => setDgpsThresholds(prev => ({ ...prev, minElevation: Number(e.target.value) }))}
                  className={cn(
                    "w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-emerald-600",
                    darkMode ? "bg-slate-700" : "bg-slate-100"
                  )}
                />
              </div>

              <div className={cn(
                "text-[10px] rounded-md px-2 py-1.5 border",
                darkMode ? "bg-slate-800/70 text-slate-200 border-slate-700" : "bg-white/80 text-slate-700 border-slate-200"
              )}>
                Candidate points: <span className="font-bold">{dgpsCandidates?.features.length ?? 0}</span>
              </div>

              <div className={cn(
                "text-[10px] rounded-md px-2 py-1.5 border space-y-1",
                darkMode ? "bg-slate-800/70 text-slate-200 border-slate-700" : "bg-white/80 text-slate-700 border-slate-200"
              )}>
                <div className="font-semibold">Field Validation Model</div>
                <div className="font-mono">Labeled: {dgpsValidationStats.total} | Accept: {dgpsValidationStats.accepted} | Reject: {dgpsValidationStats.rejected}</div>
                <div className="font-mono">Global acceptance: {(dgpsValidationStats.acceptanceRate * 100).toFixed(1)}%</div>
                {selectedDgpsCandidate && (
                  <>
                    <div className="font-mono">
                      Selected: {String(selectedDgpsCandidate.properties?.candidateId ?? 'DGPS')} (score {Number(selectedDgpsCandidate.properties?.score ?? 0).toFixed(1)})
                    </div>
                    <div className="font-mono">
                      Estimated suitability: {(estimateDgpsSuitabilityProbability(Number(selectedDgpsCandidate.properties?.score ?? 0)) * 100).toFixed(1)}%
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        onClick={() => labelSelectedDgpsCandidate('accepted')}
                        className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-500"
                      >
                        Mark Suitable
                      </button>
                      <button
                        onClick={() => labelSelectedDgpsCandidate('rejected')}
                        className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border bg-red-600 border-red-600 text-white hover:bg-red-500"
                      >
                        Mark Unsuitable
                      </button>
                    </div>
                  </>
                )}
                <button
                  onClick={clearDgpsValidationData}
                  disabled={dgpsValidationStats.total === 0}
                  className={cn(
                    "w-full px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition-all",
                    dgpsValidationStats.total === 0
                      ? "bg-slate-200 border-slate-200 text-slate-400 cursor-not-allowed"
                      : darkMode
                        ? "bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600"
                        : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                  )}
                >
                  Reset Validation Data
                </button>
              </div>

              <div className="space-y-2">
                <p className={cn("text-[10px]", darkMode ? "text-slate-300" : "text-slate-600")}>
                  Manual edit mode:
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setDgpsEditMode('off')}
                    className={cn(
                      "px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-all",
                      dgpsEditMode === 'off'
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : darkMode
                          ? "bg-slate-700 border-slate-600 text-slate-300"
                          : "bg-white border-slate-200 text-slate-600"
                    )}
                  >
                    Off
                  </button>
                  <button
                    onClick={() => setDgpsEditMode('add')}
                    className={cn(
                      "px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-all",
                      dgpsEditMode === 'add'
                        ? "bg-blue-600 border-blue-600 text-white"
                        : darkMode
                          ? "bg-slate-700 border-slate-600 text-slate-300"
                          : "bg-white border-slate-200 text-slate-600"
                    )}
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setDgpsEditMode('remove')}
                    className={cn(
                      "px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-all",
                      dgpsEditMode === 'remove'
                        ? "bg-red-600 border-red-600 text-white"
                        : darkMode
                          ? "bg-slate-700 border-slate-600 text-slate-300"
                          : "bg-white border-slate-200 text-slate-600"
                    )}
                  >
                    Remove
                  </button>
                </div>
                <p className={cn("text-[9px] font-mono", darkMode ? "text-slate-400" : "text-slate-500")}>
                  Manual points: {manualDgpsPoints.length} | Hidden generated: {removedGeneratedCandidateIds.size}
                </p>
                <button
                  onClick={undoLastDgpsEdit}
                  disabled={dgpsEditHistory.length === 0}
                  className={cn(
                    "w-full px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-all",
                    dgpsEditHistory.length === 0
                      ? "bg-slate-200 border-slate-200 text-slate-400 cursor-not-allowed"
                      : darkMode
                        ? "bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600"
                        : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                  )}
                >
                  Undo Last DGPS Edit
                </button>
                <button
                  onClick={() => {
                    setManualDgpsPoints([]);
                    setRemovedGeneratedCandidateIds(new Set());
                    setDgpsEditHistory([]);
                    setDgpsEditMode('off');
                  }}
                  className={cn(
                    "w-full px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-all",
                    darkMode
                      ? "bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600"
                      : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                  )}
                >
                  Reset DGPS Edits
                </button>
                <button
                  onClick={exportDgpsShapefile}
                  disabled={!geoJson || !dgpsCandidates || dgpsCandidates.features.length === 0}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-2 rounded-lg flex items-center justify-center gap-2 transition-all"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export DGPS Points
                </button>
              </div>
            </div>
          </section>

          {/* Survey Tools Section */}
          <section className={cn("space-y-3 pt-4 border-t border-slate-100 transition-opacity", !geoJson && "opacity-30 pointer-events-none")}>
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono flex items-center gap-2">
              <BarChart3 className="w-3 h-3" />
              Survey Tools
            </label>
            
            <div className="space-y-2">
              {/* Home Point */}
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-600 font-medium flex items-center gap-2">
                    <Home className="w-3.5 h-3.5" />
                    Home Point
                  </span>
                  {homePoint && (
                    <button
                      onClick={() => setHomePoint(null)}
                      className="text-[9px] text-red-500 hover:text-red-600 uppercase tracking-wider font-bold"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {homePoint ? (
                  <div className="text-[10px] text-slate-500 font-mono">
                    <div>{homePoint.lat.toFixed(6)}°, {homePoint.lng.toFixed(6)}°</div>
                  </div>
                ) : (
                  <p className="text-[9px] text-slate-400 italic">Ctrl+Click map to set</p>
                )}
              </div>

              {/* Measurement Tool */}
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                <div className="flex items-center gap-2 mb-2">
                  <Ruler className="w-3.5 h-3.5 text-slate-600" />
                  <span className="text-xs text-slate-600 font-medium">Measurement</span>
                </div>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => setMeasurementMode(measurementMode === 'distance' ? 'off' : 'distance')}
                    className={cn(
                      "flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all",
                      measurementMode === 'distance'
                        ? "bg-blue-600 text-white"
                        : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    Distance
                  </button>
                  <button
                    onClick={() => setMeasurementMode(measurementMode === 'area' ? 'off' : 'area')}
                    className={cn(
                      "flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all",
                      measurementMode === 'area'
                        ? "bg-blue-600 text-white"
                        : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    Area
                  </button>
                </div>
                {measurementMode !== 'off' && (
                  <div className="space-y-1">
                    {measurementMode === 'distance' && measurementPoints.length >= 2 && (
                      <p className="text-[10px] text-blue-600 font-mono font-bold">
                        {calculateMeasurementDistance().toFixed(2)} m
                      </p>
                    )}
                    {measurementMode === 'area' && measurementPoints.length >= 3 && (
                      <p className="text-[10px] text-blue-600 font-mono font-bold">
                        {calculateMeasurementArea().toFixed(2)} m²
                      </p>
                    )}
                    <button
                      onClick={clearMeasurement}
                      className="text-[9px] text-red-500 hover:text-red-600 uppercase tracking-wider font-bold"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-600 font-medium flex items-center gap-2">
                    <StickyNote className="w-3.5 h-3.5" />
                    Notes ({notes.length})
                  </span>
                  <button
                    onClick={() => setIsAddingNote(!isAddingNote)}
                    className={cn(
                      "px-2 py-1 rounded text-[9px] font-bold transition-all",
                      isAddingNote
                        ? "bg-amber-600 text-white"
                        : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    {isAddingNote ? 'Cancel' : 'Add'}
                  </button>
                </div>
                {isAddingNote && (
                  <p className="text-[9px] text-amber-600 italic">Click map to place note</p>
                )}
                {notes.length > 0 && (
                  <button
                    onClick={() => setNotes([])}
                    className="text-[9px] text-red-500 hover:text-red-600 uppercase tracking-wider font-bold mt-1"
                  >
                    Clear All
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Statistics Dashboard */}
          {flightLines && tieLines && stats && (
            <section className="pt-4 border-t border-slate-100">
              <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono mb-3 flex items-center gap-2">
                <BarChart3 className="w-3 h-3" />
                Survey Statistics
              </label>
              
              <div className="space-y-2">
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-100">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[9px] text-blue-600 uppercase font-mono mb-0.5">Flight Lines</p>
                      <p className="text-lg font-bold text-blue-900">{flightLines.features.length}</p>
                      <p className="text-[8px] text-blue-600 font-mono">{stats.flightLength} km</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-600 uppercase font-mono mb-0.5">Tie Lines</p>
                      <p className="text-lg font-bold text-slate-900">{tieLines.features.length}</p>
                      <p className="text-[8px] text-slate-600 font-mono">{stats.tieLength} km</p>
                    </div>
                  </div>
                </div>
                
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                  <p className="text-[9px] text-slate-400 uppercase font-mono mb-1">Total Distance</p>
                  <p className="text-xl font-bold text-slate-900 font-mono">{stats.totalLength} <span className="text-xs opacity-50">km</span></p>
                </div>

                {/* Progress Summary */}
                {Object.keys(lineProgress).length > 0 && (
                  <div className="bg-gradient-to-r from-emerald-50 to-green-50 rounded-lg p-3 border border-emerald-100">
                    <p className="text-[9px] text-emerald-600 uppercase font-mono mb-2">Progress</p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-green-600">✓ Completed</span>
                        <span className="font-bold text-green-700">
                          {Object.values(lineProgress).filter(s => s === 'completed').length}
                        </span>
                      </div>
                      <div className="flex justify-between text-[10px]">
                        <span className="text-amber-600">⚡ In Progress</span>
                        <span className="font-bold text-amber-700">
                          {Object.values(lineProgress).filter(s => s === 'in-progress').length}
                        </span>
                      </div>
                      <div className="flex justify-between text-[10px]">
                        <span className="text-slate-400">○ Pending</span>
                        <span className="font-bold text-slate-600">
                          {((flightLines?.features.length || 0) + (tieLines?.features.length || 0)) - Object.keys(lineProgress).length}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

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







        </div>

        <div className="p-6 border-t border-slate-100 bg-slate-50 space-y-3">
          <div className="space-y-3">
            <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono">Export Format</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'csv', label: 'csv' },
                { value: 'geojson', label: 'geojson' },
                { value: 'kml', label: 'kml' },
                { value: 'kmz', label: 'kmz' },
                { value: 'dgps-shp', label: 'dgps-shp' },
                { value: 'preflight-kml', label: 'pre-kml' },
                { value: 'preflight-kmz', label: 'pre-kmz' }
              ] as const).map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setExportFormat(value)}
                  className={cn(
                    "py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border",
                    exportFormat === value 
                      ? "bg-blue-600 border-blue-600 text-white" 
                      : darkMode
                        ? "bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200 hover:bg-slate-600"
                        : "bg-white border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-slate-50"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {(exportFormat === 'preflight-kml' || exportFormat === 'preflight-kmz') && (
            <div className="space-y-2">
              <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-mono">Pre-Flight File Prefix</label>
              <input
                type="text"
                value={preflightFilePrefix}
                onChange={(e) => setPreflightFilePrefix(e.target.value)}
                placeholder="e.g. Mission-A"
                className={cn(
                  "w-full px-3 py-2 rounded-lg border text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400",
                  darkMode ? "bg-slate-700 border-slate-600 text-slate-200" : "bg-white border-slate-200 text-slate-700"
                )}
              />
              <p className="text-[9px] text-slate-400 font-mono">
                Sequential output: {preflightFilePrefix.trim() || 'drone-plan'}{preflightFilePrefix.trim().match(/\d+$/) ? '' : '-001'}.{exportFormat === 'preflight-kml' ? 'kml' : 'kmz'}
              </p>
            </div>
          )}

          <button 
            disabled={!geoJson}
            onClick={handleExport}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-100 disabled:text-slate-300 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-blue-600/10"
          >
            <Download className="w-4 h-4" />
            Generate & Export
          </button>
          <p className="text-[9px] text-center text-slate-400 mt-4 uppercase tracking-tighter">
            Exported as {exportFormat === 'csv'
              ? 'ZIP (2 CSV files - Summary & Line Details)'
              : exportFormat === 'dgps-shp'
                ? 'ZIP (DGPS point shapefile)'
              : exportFormat === 'preflight-kml'
                ? 'ZIP (Individual KML per line, sequential names)'
                : exportFormat === 'preflight-kmz'
                  ? 'ZIP (Individual KMZ per line, sequential names)'
                  : exportFormat.toUpperCase() + ' (WGS84)'}
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className={cn(
        "flex-1 relative",
        darkMode ? "bg-slate-800" : "bg-slate-50"
      )}>
        {isProcessing && (
          <div className="absolute inset-0 z-[1000] bg-white/40 backdrop-blur-sm flex items-center justify-center">
            <div className={cn(
              "px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 border",
              darkMode ? "bg-slate-800 text-slate-100 border-slate-700" : "bg-white text-slate-900 border-slate-200"
            )}>
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

          {allFlightLines && showFlightLines && (
            <GeoJSON 
              key={`flight-${settings.flightLineSpacing}-${settings.angle}-${settings.flightLineColor}-${manualEditCounter}-${Object.keys(lineProgress).length}-${importedLineFeatures.length}`}
              data={allFlightLines} 
              style={(feature) => {
                const progressColor = feature?.id ? getProgressColor(feature.id as string) : undefined;
                const isImported = feature?.properties?.source === 'imported';
                return {
                  color: selectedLineId === feature?.id ? '#ffffff' : progressColor || settings.flightLineColor,
                  weight: selectedLineId === feature?.id ? 4 : isImported ? 3 : 2,
                  opacity: isImported ? 0.9 : 0.8,
                  dashArray: isImported ? '8, 4' : undefined,
                  cursor: isEditMode ? 'pointer' : 'default'
                };
              }}
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

          {allTieLines && showTieLines && (
            <GeoJSON 
              key={`tie-${settings.tieLineSpacing}-${settings.angle}-${settings.tieLineColor}-${manualEditCounter}-${Object.keys(lineProgress).length}-${importedLineFeatures.length}`}
              data={allTieLines} 
              style={(feature) => {
                const progressColor = feature?.id ? getProgressColor(feature.id as string) : undefined;
                const isImported = feature?.properties?.source === 'imported';
                return {
                  color: selectedLineId === feature?.id ? '#ffffff' : progressColor || settings.tieLineColor,
                  weight: selectedLineId === feature?.id ? 3 : isImported ? 2 : 1.5,
                  opacity: isImported ? 0.7 : 0.6,
                  dashArray: isImported ? '8, 4' : '4, 4',
                  cursor: isEditMode ? 'pointer' : 'default'
                };
              }}
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

          {dgpsCandidates && showDgpsCandidates && (
            <GeoJSON
              key={`dgps-${dgpsCandidates.features.length}-${dgpsEditMode}-${removedGeneratedCandidateIds.size}-${manualDgpsPoints.length}-${selectedDgpsCandidateId}`}
              data={dgpsCandidates as any}
              pointToLayer={(feature, latlng) => {
                const score = Number(feature.properties?.score ?? 0);
                const candidateId = String(feature.properties?.candidateId ?? '');
                const isSelected = candidateId === selectedDgpsCandidateId;
                const color = score >= 80 ? '#16a34a' : score >= 65 ? '#22c55e' : '#84cc16';
                return L.circleMarker(latlng, {
                  radius: isSelected ? 7 : 5,
                  color,
                  fillColor: color,
                  fillOpacity: 0.85,
                  weight: isSelected ? 3 : 1.5
                });
              }}
              onEachFeature={(feature, layer) => {
                const rank = Number(feature.properties?.rank ?? 0);
                const id = String(feature.properties?.candidateId ?? 'DGPS');
                const score = Number(feature.properties?.score ?? 0).toFixed(1);
                const scoreValue = Number(feature.properties?.score ?? 0);
                const ndvi = Number(feature.properties?.ndvi ?? 0).toFixed(3);
                const ndbi = Number(feature.properties?.ndbi ?? 0).toFixed(3);
                const elev = Number(feature.properties?.elevationM ?? 0).toFixed(1);
                const slope = Number(feature.properties?.slopeDeg ?? 0).toFixed(2);
                const source = String(feature.properties?.source ?? 'generated');
                const probability = (estimateDgpsSuitabilityProbability(scoreValue) * 100).toFixed(1);
                const validation = dgpsValidationRecords[id]?.label ?? 'unlabeled';

                layer.bindTooltip(
                  `<div style="font-size:11px;line-height:1.35;">
                    <div><strong>#${rank} ${id}</strong></div>
                    <div>Score: ${score}</div>
                    <div>Suitability: ${probability}%</div>
                    <div>Validation: ${validation}</div>
                    <div>Source: ${source}</div>
                    <div>NDVI: ${ndvi}</div>
                    <div>NDBI: ${ndbi}</div>
                    <div>Elevation: ${elev} m</div>
                    <div>Slope: ${slope} deg</div>
                  </div>`,
                  { sticky: true, opacity: 0.95 }
                );

                layer.on('click', () => {
                  setSelectedDgpsCandidateId(id);
                  if (dgpsEditMode !== 'remove') return;

                  const candidateId = String(feature.properties?.candidateId ?? '');
                  const sourceType = String(feature.properties?.source ?? 'generated');
                  const featurePoint = feature as Feature<Point>;

                  if (sourceType === 'manual') {
                    setManualDgpsPoints(prev => prev.filter(
                      p => String(p.properties?.candidateId) !== candidateId
                    ));
                    setDgpsEditHistory(prev => [...prev, {
                      type: 'remove-manual',
                      candidateId,
                      candidate: featurePoint
                    }]);
                  } else {
                    setRemovedGeneratedCandidateIds(prev => {
                      const cloned = new Set(prev);
                      cloned.add(candidateId);
                      return cloned;
                    });
                    setDgpsEditHistory(prev => [...prev, {
                      type: 'remove-generated',
                      candidateId,
                      candidate: featurePoint
                    }]);
                  }
                });
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
              if (isEditMode) {
                setSelectedLineId(null);
              } else {
                handleMapClick(e);
              }
            }}
            onMouseMove={(e: any) => {
              setCursorCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
            }}
          />

          {/* Home Point Marker */}
          {homePoint && (
            <Marker
              position={[homePoint.lat, homePoint.lng]}
              icon={L.divIcon({
                className: '',
                html: '<div style="background: #ef4444; border: 3px solid white; border-radius: 50%; width: 20px; height: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
              })}
            >
              <LeafletTooltip permanent direction="top" offset={[0, -10]}>
                <span style={{fontSize: '10px', fontWeight: 'bold'}}>🏠 Home</span>
              </LeafletTooltip>
            </Marker>
          )}

          {/* Notes Markers */}
          {notes.map(note => (
            <Marker
              key={note.id}
              position={[note.lat, note.lng]}
              icon={L.divIcon({
                className: '',
                html: '<div style="background: #fbbf24; border: 2px solid white; border-radius: 4px; width: 16px; height: 16px; box-shadow: 0 2px 6px rgba(0,0,0,0.3); display: flex; align-items: center; justify-center; font-size: 10px;">📝</div>',
                iconSize: [16, 16],
                iconAnchor: [8, 8]
              })}
            >
              <LeafletTooltip direction="top" offset={[0, -8]}>
                <div style={{maxWidth: '200px'}}>
                  <div style={{fontSize: '10px', fontWeight: 'bold', marginBottom: '2px'}}>Note</div>
                  <div style={{fontSize: '9px'}}>{note.text}</div>
                  <button 
                    onClick={() => setNotes(prev => prev.filter(n => n.id !== note.id))}
                    style={{marginTop: '4px', fontSize: '8px', color: '#ef4444', cursor: 'pointer', background: 'none', border: 'none', textDecoration: 'underline'}}
                  >
                    Delete
                  </button>
                </div>
              </LeafletTooltip>
            </Marker>
          ))}

          {/* Measurement Points */}
          {measurementPoints.map((point, idx) => (
            <Marker
              key={`measure-${idx}`}
              position={[point[1], point[0]]}
              icon={L.divIcon({
                className: '',
                html: `<div style="background: #3b82f6; border: 2px solid white; border-radius: 50%; width: 12px; height: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-center; font-size: 8px; color: white; font-weight: bold;">${idx + 1}</div>`,
                iconSize: [12, 12],
                iconAnchor: [6, 6]
              })}
            />
          ))}

          {/* Measurement Lines */}
          {measurementMode !== 'off' && measurementPoints.length > 0 && (
            <GeoJSON
              key={`measurement-${measurementPoints.length}`}
              data={{
                type: 'FeatureCollection',
                features: measurementMode === 'distance' && measurementPoints.length >= 2
                  ? [turf.lineString(measurementPoints)]
                  : measurementMode === 'area' && measurementPoints.length >= 3
                  ? [turf.polygon([[...measurementPoints, measurementPoints[0]]])]
                  : []
              } as any}
              style={{
                color: '#3b82f6',
                weight: 2,
                fillColor: '#3b82f6',
                fillOpacity: 0.1,
                dashArray: '5, 5'
              }}
            />
          )}

          {/* Line Labels */}
          {showLineLabels && flightLines && showFlightLines && (
            <>
              {flightLines.features.flatMap((feature, idx) => {
                const coords = feature.geometry.coordinates;
                const lineId = `FL-${idx + 1}`;
                const labels = lineLabels[lineId] || { start: lineId, end: lineId };
                
                return [
                  <Marker
                    key={`fl-label-start-${idx}`}
                    position={[coords[0][1], coords[0][0]]}
                    icon={L.divIcon({
                      className: 'custom-label-marker',
                      html: `<div style="background: rgba(37, 99, 235, 0.9); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2); cursor: pointer;">${labels.start}</div>`,
                      iconSize: [40, 20],
                      iconAnchor: [20, 10]
                    })}
                    eventHandlers={{
                      click: (e) => {
                        L.DomEvent.stopPropagation(e);
                        setEditingLabel({ lineId, position: 'start', currentValue: labels.start });
                      }
                    }}
                  />,
                  <Marker
                    key={`fl-label-end-${idx}`}
                    position={[coords[coords.length - 1][1], coords[coords.length - 1][0]]}
                    icon={L.divIcon({
                      className: 'custom-label-marker',
                      html: `<div style="background: rgba(37, 99, 235, 0.9); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2); cursor: pointer;">${labels.end}</div>`,
                      iconSize: [40, 20],
                      iconAnchor: [20, 10]
                    })}
                    eventHandlers={{
                      click: (e) => {
                        L.DomEvent.stopPropagation(e);
                        setEditingLabel({ lineId, position: 'end', currentValue: labels.end });
                      }
                    }}
                  />
                ];
              })}
            </>
          )}

          {showLineLabels && tieLines && showTieLines && (
            <>
              {tieLines.features.flatMap((feature, idx) => {
                const coords = feature.geometry.coordinates;
                const lineId = `TL-${idx + 1}`;
                const labels = lineLabels[lineId] || { start: lineId, end: lineId };
                
                return [
                  <Marker
                    key={`tl-label-start-${idx}`}
                    position={[coords[0][1], coords[0][0]]}
                    icon={L.divIcon({
                      className: 'custom-label-marker',
                      html: `<div style="background: rgba(100, 116, 139, 0.9); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2); cursor: pointer;">${labels.start}</div>`,
                      iconSize: [40, 20],
                      iconAnchor: [20, 10]
                    })}
                    eventHandlers={{
                      click: (e) => {
                        L.DomEvent.stopPropagation(e);
                        setEditingLabel({ lineId, position: 'start', currentValue: labels.start });
                      }
                    }}
                  />,
                  <Marker
                    key={`tl-label-end-${idx}`}
                    position={[coords[coords.length - 1][1], coords[coords.length - 1][0]]}
                    icon={L.divIcon({
                      className: 'custom-label-marker',
                      html: `<div style="background: rgba(100, 116, 139, 0.9); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2); cursor: pointer;">${labels.end}</div>`,
                      iconSize: [40, 20],
                      iconAnchor: [20, 10]
                    })}
                    eventHandlers={{
                      click: (e) => {
                        L.DomEvent.stopPropagation(e);
                        setEditingLabel({ lineId, position: 'end', currentValue: labels.end });
                      }
                    }}
                  />
                ];
              })}
            </>
          )}
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
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-emerald-500" />
                <span className="text-xs text-black/80 font-medium">DGPS Candidates</span>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-black/5">
              <Logo light grayscale size="small" />
            </div>
          </div>
        </div>

        {/* Coordinate Display */}
        {cursorCoords && (
          <div className="absolute bottom-6 left-6 z-[1000] bg-white/90 backdrop-blur-md p-3 rounded-xl shadow-lg border border-black/5">
            <div className="flex items-center gap-2 mb-2">
              <Crosshair className="w-3 h-3 text-slate-400" />
              <span className="text-[9px] text-slate-400 uppercase tracking-wider font-mono">Coordinates</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[8px] text-slate-400 uppercase">Lat, Lon</p>
                  <p className="text-[10px] font-mono text-slate-900 font-bold">
                    {cursorCoords.lat.toFixed(6)}°, {cursorCoords.lng.toFixed(6)}°
                  </p>
                </div>
                <button
                  onClick={() => copyToClipboard(`${cursorCoords.lat.toFixed(6)}, ${cursorCoords.lng.toFixed(6)}`)}
                  className="p-1.5 hover:bg-blue-50 rounded text-slate-400 hover:text-blue-600 transition-colors"
                  title="Copy coordinates"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              <div>
                <p className="text-[8px] text-slate-400 uppercase">UTM</p>
                <p className="text-[10px] font-mono text-slate-600">
                  {latLngToUTM(cursorCoords.lat, cursorCoords.lng).easting}, {latLngToUTM(cursorCoords.lat, cursorCoords.lng).northing}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Progress Tracker for Selected Line */}
        {selectedLineId && isEditMode && (
          <div className="absolute top-24 right-6 z-[1000] bg-white/90 backdrop-blur-md p-3 rounded-xl shadow-lg border border-black/5">
            <div className="flex items-center gap-2 mb-2">
              <Check className="w-3 h-3 text-slate-400" />
              <span className="text-[9px] text-slate-400 uppercase tracking-wider font-mono">Line Status</span>
            </div>
            <button
              onClick={() => toggleLineProgress(selectedLineId)}
              className={cn(
                "w-full px-3 py-2 rounded-lg text-[10px] font-bold transition-all",
                lineProgress[selectedLineId] === 'completed' ? "bg-green-100 text-green-700 border-2 border-green-300" :
                lineProgress[selectedLineId] === 'in-progress' ? "bg-amber-100 text-amber-700 border-2 border-amber-300" :
                "bg-slate-50 text-slate-600 border-2 border-slate-200 hover:bg-slate-100"
              )}
            >
              {lineProgress[selectedLineId] === 'completed' ? '✓ Completed' :
               lineProgress[selectedLineId] === 'in-progress' ? '⚡ In Progress' :
               '○ Mark Status'}
            </button>
          </div>
        )}

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
        {elevationProfile && selectedLineId && (
          <motion.div 
            initial={{ y: 300, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 300, opacity: 0 }}
            className="absolute bottom-6 left-80 right-6 z-[1000] bg-white/90 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-200 p-6 flex flex-col gap-4 max-h-96 overflow-y-auto"
          >
            {(() => {
              const line = [...(flightLines?.features || []), ...(tieLines?.features || [])].find(f => f.id === selectedLineId);
              const lineStats = line ? calculateLineStats(line as Feature<LineString>, defaultMissionSettings) : null;
              const isFlightLine = flightLines?.features.some(f => f.id === selectedLineId);
              
              return (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Activity className="w-4 h-4 text-blue-600" />
                      <div>
                        <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                          {isFlightLine ? 'Flight Line' : 'Tie Line'} Details
                        </h3>
                        <p className="text-[10px] text-slate-400">Line ID: {selectedLineId}</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setElevationProfile(null)}
                      className="p-1.5 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {lineStats && (
                    <div className="grid grid-cols-4 gap-2 bg-gradient-to-r from-blue-50 to-slate-50 rounded-lg p-3 border border-blue-100">
                      <div className="flex flex-col">
                        <p className="text-[9px] text-slate-400 uppercase font-mono">Distance</p>
                        <p className="text-sm font-bold text-slate-900">{lineStats.distance} <span className="text-[9px] opacity-60">km</span></p>
                      </div>
                      <div className="flex flex-col">
                        <p className="text-[9px] text-slate-400 uppercase font-mono">Flight Time</p>
                        <p className="text-sm font-bold text-blue-600">{lineStats.timeString}</p>
                      </div>
                      <div className="flex flex-col">
                        <p className="text-[9px] text-slate-400 uppercase font-mono">Battery %</p>
                        <p className="text-sm font-bold text-emerald-600">{lineStats.batteryPercentage}%</p>
                      </div>
                      <div className="flex flex-col">
                        <p className="text-[9px] text-slate-400 uppercase font-mono">Power (Wh)</p>
                        <p className="text-sm font-bold text-orange-600">{lineStats.powerConsumption}</p>
                      </div>
                    </div>
                  )}

                  {/* Advanced Flight Analysis Button */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (!showAdvancedStats && line) {
                          fetchAdvancedFlightStats(line as Feature<LineString>);
                        } else {
                          setShowAdvancedStats(!showAdvancedStats);
                        }
                      }}
                      disabled={isFetchingAdvancedStats}
                      className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-slate-300 disabled:to-slate-400 text-white font-bold py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 transition-all text-xs shadow-lg shadow-purple-600/20"
                    >
                      {isFetchingAdvancedStats ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Calculating...
                        </>
                      ) : (
                        <>
                          <Activity className="w-3.5 h-3.5" />
                          {advancedFlightStats ? 'Hide' : 'Advanced Flight Analysis'}
                        </>
                      )}
                    </button>
                  </div>

                  {/* Advanced Stats Display */}
                  {showAdvancedStats && advancedFlightStats && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="space-y-3"
                    >
                      <div className="bg-gradient-to-br from-purple-50 via-indigo-50 to-blue-50 rounded-xl p-4 border border-purple-200 space-y-3">
                        <h4 className="text-xs font-bold text-purple-900 uppercase tracking-wider flex items-center gap-2">
                          <Activity className="w-3.5 h-3.5" />
                          Advanced Flight Analysis (1.2kg Payload)
                        </h4>
                        
                        {/* Time Breakdown */}
                        <div className="grid grid-cols-5 gap-2">
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Total Time</p>
                            <p className="text-sm font-bold text-purple-700">{formatTime(advancedFlightStats.totalFlightTime)}</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-red-500 uppercase font-mono mb-0.5">Climb</p>
                            <p className="text-xs font-bold text-red-600">{advancedFlightStats.climbTime.toFixed(1)}m</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-blue-500 uppercase font-mono mb-0.5">Cruise</p>
                            <p className="text-xs font-bold text-blue-600">{advancedFlightStats.cruiseTime.toFixed(1)}m</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-green-500 uppercase font-mono mb-0.5">Descent</p>
                            <p className="text-xs font-bold text-green-600">{advancedFlightStats.descentTime.toFixed(1)}m</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-yellow-600 uppercase font-mono mb-0.5">Hover</p>
                            <p className="text-xs font-bold text-yellow-600">{advancedFlightStats.hoverTime.toFixed(1)}m</p>
                          </div>
                        </div>

                        {/* Energy Breakdown */}
                        <div className="grid grid-cols-5 gap-2">
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Total Energy</p>
                            <p className="text-sm font-bold text-orange-700">{advancedFlightStats.totalEnergyWh.toFixed(0)} Wh</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-red-500 uppercase font-mono mb-0.5">Climb</p>
                            <p className="text-xs font-bold text-red-600">{advancedFlightStats.climbEnergyWh.toFixed(0)} Wh</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-blue-500 uppercase font-mono mb-0.5">Cruise</p>
                            <p className="text-xs font-bold text-blue-600">{advancedFlightStats.cruiseEnergyWh.toFixed(0)} Wh</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-green-500 uppercase font-mono mb-0.5">Descent</p>
                            <p className="text-xs font-bold text-green-600">{advancedFlightStats.descentEnergyWh.toFixed(0)} Wh</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-yellow-600 uppercase font-mono mb-0.5">Hover</p>
                            <p className="text-xs font-bold text-yellow-600">{advancedFlightStats.hoverEnergyWh.toFixed(0)} Wh</p>
                          </div>
                        </div>

                        {/* Terrain Following & Waypoints */}
                        <div className="grid grid-cols-5 gap-2">
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">2D Distance</p>
                            <p className="text-xs font-bold text-slate-700">{(advancedFlightStats.horizontalDistance / 1000).toFixed(2)} km</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-purple-600 uppercase font-mono mb-0.5">3D Distance</p>
                            <p className="text-xs font-bold text-purple-700">{(advancedFlightStats.actualDistance3D / 1000).toFixed(2)} km</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Terrain +</p>
                            <p className="text-xs font-bold text-indigo-600">{((advancedFlightStats.terrainFollowingFactor - 1) * 100).toFixed(1)}%</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Waypoints</p>
                            <p className="text-xs font-bold text-blue-700">{advancedFlightStats.numberOfWaypoints}</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Turns</p>
                            <p className="text-xs font-bold text-cyan-700">{advancedFlightStats.numberOfTurns}</p>
                          </div>
                        </div>

                        {/* Terrain Type & Waypoint Spacing */}
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg p-2.5 border border-emerald-200">
                            <p className="text-[8px] text-emerald-600 uppercase font-mono mb-0.5">Terrain Type</p>
                            <p className="text-sm font-bold text-emerald-700">{advancedFlightStats.terrainType}</p>
                            <p className="text-[7px] text-emerald-600 mt-0.5">
                              {advancedFlightStats.terrainType === 'Flat' && 'Flat to gently rolling'}
                              {advancedFlightStats.terrainType === 'Rolling' && 'Rolling terrain (typical)'}
                              {advancedFlightStats.terrainType === 'Rugged' && 'Rugged/steep terrain'}
                            </p>
                          </div>
                          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-2.5 border border-blue-200">
                            <p className="text-[8px] text-blue-600 uppercase font-mono mb-0.5">Waypoint Spacing</p>
                            <p className="text-sm font-bold text-blue-700">{advancedFlightStats.waypointSpacing}m</p>
                            <p className="text-[7px] text-blue-600 mt-0.5">Optimized for mag survey</p>
                          </div>
                        </div>

                        {/* Battery & Environmental */}
                        <div className="grid grid-cols-4 gap-2">
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Battery Used</p>
                            <p className="text-sm font-bold text-emerald-700">{advancedFlightStats.batteryPercentage.toFixed(1)}%</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Wind @ Alt</p>
                            <p className="text-xs font-bold text-cyan-600">{advancedFlightStats.avgWindResistance.toFixed(1)} m/s</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Elev Gain</p>
                            <p className="text-xs font-bold text-amber-600">+{advancedFlightStats.elevationGain.toFixed(0)}m</p>
                          </div>
                          <div className="bg-white/60 rounded-lg p-2">
                            <p className="text-[8px] text-slate-500 uppercase font-mono mb-0.5">Elev Loss</p>
                            <p className="text-xs font-bold text-teal-600">-{advancedFlightStats.elevationLoss.toFixed(0)}m</p>
                          </div>
                        </div>

                        {/* Analysis Notes */}
                        <div className="bg-white/40 rounded-lg p-2.5 border border-purple-200">
                          <p className="text-[9px] text-slate-600 leading-relaxed">
                            <span className="font-bold text-purple-700">📊 Mag Survey Analysis:</span> This calculation uses physics-based modeling optimized for UAV magnetometry: (1) <strong>Adaptive Waypoint Spacing</strong> - {advancedFlightStats.waypointSpacing}m spacing based on {advancedFlightStats.terrainType.toLowerCase()} terrain (flat: 20m, rolling: 15m, rugged: 10m) for optimal {advancedFlightStats.numberOfWaypoints} waypoints with consistent magnetic signal; (2) <strong>Terrain Following</strong> - 3D distance {((advancedFlightStats.terrainFollowingFactor - 1) * 100).toFixed(1)}% longer maintaining 50-88m AGL; (3) <strong>Hover/Turn Energy</strong> - 2s/waypoint + 1s/turn = {advancedFlightStats.hoverTime.toFixed(1)}min; (4) <strong>Phase Power</strong> - climb ~2.5x, descent ~35%; (5) <strong>Wind @ {defaultMissionSettings.altitude}m</strong> - {advancedFlightStats.avgWindResistance.toFixed(1)} m/s; (6) <strong>Battery</strong> - 20% reserve. Includes 1.2kg mag arrow payload.
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span>Elevation Profile ({isFetchingElevation ? 'Loading...' : 'Open-Elevation (SRTM)'})</span>
                    {isFetchingElevation && <Loader2 className="w-3 h-3 animate-spin text-blue-600" />}
                  </div>
                  
                  <div className="flex-1 w-full min-h-[200px]">
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
                </>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
