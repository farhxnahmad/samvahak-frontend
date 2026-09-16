'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapGL, { Source, Layer as MapLayer, Marker, type MapRef, type LayerProps } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  CloudRain,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  Cloud,
  Sun,
  Truck as TruckIcon,
  Package,
  AlertTriangle,
  Route as RouteIcon,
  MessageSquareWarning,
  X,
  ArrowUpDown,
  Navigation,
} from 'lucide-react';

type LngLat = [number, number];

// ---------------------------------------------------------------------------
// Default mock data
// ---------------------------------------------------------------------------

const DEFAULT_MAPBOX_TOKEN =
  'pk.eyJ1Ijoia2FtZW93d3ciLCJhIjoiY211MHNtZmNmMDVvNjJ5c2FkYTVoMzQ5byJ9.OskXRtPn-dRTqyN6k-yVyQ';

// Where the camera settles once the cinematic intro finishes.
const REGIONAL_VIEW_STATE = {
  longitude: 94.05,
  latitude: 25.0,
  zoom: 9,
  pitch: 65,
  bearing: -20,
};

// The camera opens from orbit and glides down into the region — see
// `handleMapLoad`, which kicks off the flyTo once the style has painted.
const ORBITAL_VIEW_STATE = {
  longitude: 92.8,
  latitude: 25.6,
  zoom: 3.1,
  pitch: 0,
  bearing: 0,
};

// Imphal -> Ukhrul hill corridor. Vertex index 4 (94.051, 25.005) is the
// hazard point: where the landslide sits and where the alternate route branches.
const DEFAULT_PRIMARY_ROUTE: LngLat[] = [
  [93.9368, 24.817], // Imphal
  [93.972, 24.861],
  [94.005, 24.902],
  [94.029, 24.952],
  [94.051, 25.005], // <- hazard point / branch point
  [94.079, 25.048],
  [94.11, 25.081],
  [94.3667, 25.1167], // Ukhrul
];

const DEFAULT_ALTERNATIVE_ROUTE: LngLat[] = [
  [94.051, 25.005], // shares the branch point, no gap when drawn
  [94.085, 24.985],
  [94.145, 24.995],
  [94.205, 25.03],
  [94.265, 25.07],
  [94.32, 25.095],
  [94.3667, 25.1167], // Ukhrul
];

// Vertex 4 of 7 segments in => hazard sits 4/7 of the way along the primary route
const DEFAULT_HAZARD_FRACTION = 4 / 7;

// Demo weather regions. In production these coordinates + conditions come from
// IMD / OpenWeather / an internal weather service — see `WeatherRegion` below.
type WeatherCondition = 'clear' | 'partly-cloudy' | 'rain' | 'heavy-rain' | 'storm' | 'fog';

interface WeatherRegion {
  id: string;
  name: string;
  lng: number;
  lat: number;
  condition: WeatherCondition;
  /** 0..1, drives cloud density / opacity / drift range */
  intensity: number;
}

const DEMO_WEATHER: WeatherRegion[] = [
  { id: 'shillong', name: 'Shillong', lng: 91.8933, lat: 25.5788, condition: 'heavy-rain', intensity: 0.9 },
  { id: 'tawang', name: 'Tawang', lng: 91.8697, lat: 27.5859, condition: 'fog', intensity: 0.55 },
  { id: 'guwahati', name: 'Guwahati', lng: 91.7362, lat: 26.1445, condition: 'clear', intensity: 0.1 },
  { id: 'imphal', name: 'Imphal', lng: 93.9368, lat: 24.817, condition: 'partly-cloudy', intensity: 0.35 },
  { id: 'aizawl', name: 'Aizawl', lng: 92.7173, lat: 23.7271, condition: 'rain', intensity: 0.6 },
  { id: 'kohima', name: 'Kohima', lng: 94.1077, lat: 25.6751, condition: 'partly-cloudy', intensity: 0.4 },
  { id: 'gangtok', name: 'Gangtok', lng: 88.6138, lat: 27.3389, condition: 'fog', intensity: 0.5 },
  { id: 'agartala', name: 'Agartala', lng: 91.2868, lat: 23.8315, condition: 'rain', intensity: 0.45 },
];

const WEATHER_META: Record<WeatherCondition, { label: string; icon: typeof Sun; color: string }> = {
  clear: { label: 'Clear', icon: Sun, color: '#fbbf24' },
  'partly-cloudy': { label: 'Partly Cloudy', icon: Cloud, color: '#cbd5e1' },
  rain: { label: 'Rain', icon: CloudDrizzle, color: '#7dd3fc' },
  'heavy-rain': { label: 'Heavy Rain', icon: CloudRain, color: '#38bdf8' },
  storm: { label: 'Storm', icon: CloudLightning, color: '#a78bfa' },
  fog: { label: 'Fog', icon: CloudFog, color: '#e2e8f0' },
};

interface CitizenReport {
  id: string;
  lng: number;
  lat: number;
  message: string;
}

const DEMO_CITIZEN_REPORT: CitizenReport = {
  id: 'report-1',
  lng: 94.29,
  lat: 25.09,
  message: 'Low visibility reported near Ukhrul approach road.',
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function cumulativeLengths(coords: LngLat[]) {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    total += Math.hypot(lng2 - lng1, lat2 - lat1);
    cum.push(total);
  }
  return { cum, total };
}

/** Point at `fraction` (0..1) along a coordinate path, by arc length. */
function pointAtFraction(coords: LngLat[], fraction: number): LngLat {
  const { cum, total } = cumulativeLengths(coords);
  const target = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 1; i < cum.length; i++) {
    if (target <= cum[i] || i === cum.length - 1) {
      const segStart = cum[i - 1];
      const segEnd = cum[i];
      const segFrac = segEnd === segStart ? 0 : (target - segStart) / (segEnd - segStart);
      const [lng1, lat1] = coords[i - 1];
      const [lng2, lat2] = coords[i];
      return [lng1 + (lng2 - lng1) * segFrac, lat1 + (lat2 - lat1) * segFrac];
    }
  }
  return coords[coords.length - 1];
}

/** Sub-path of `coords` from fraction 0 up to `fraction`, for partial line rendering. */
function sliceUpToFraction(coords: LngLat[], fraction: number): LngLat[] {
  const { cum, total } = cumulativeLengths(coords);
  const target = Math.max(0, Math.min(1, fraction)) * total;
  const result: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] <= target) {
      result.push(coords[i]);
    } else {
      result.push(pointAtFraction(coords, fraction));
      break;
    }
  }
  return result;
}

function toLineFeature(coords: LngLat[]) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: coords },
    properties: {},
  };
}

/** Small deterministic hash so per-region cloud drift is stable across renders
 *  without every region animating in lockstep. */
function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// Animation state machine
// ---------------------------------------------------------------------------

type Phase = 'normal' | 'hazard' | 'rerouting' | 'resolved' | 'arrived';

const SPEED = 0.09; // fraction of a route traversed per second
const HAZARD_PAUSE_MS = 2000; // how long the pulsing alert holds before AI acts
const REROUTE_REVEAL_MS = 1300; // how long the "rerouting" text/cyan reveal holds
const ARRIVAL_PAUSE_MS = 1600; // pause at destination before the loop restarts

const PHASE_TEXT: Record<Phase, { label: string; className: string }> = {
  normal: { label: 'Status: Normal | Essential Goods En Route', className: 'text-slate-200' },
  hazard: { label: 'ALERT: Landslide Detected. Route Blocked.', className: 'text-amber-400' },
  rerouting: { label: 'AI Engine Active: Rerouting via safe corridor...', className: 'text-cyan-300' },
  resolved: { label: 'AI Engine Active: Rerouting via safe corridor...', className: 'text-cyan-300' },
  arrived: { label: 'Delivered Safely | Cycle Restarting', className: 'text-emerald-300' },
};

// Route Risk Index shown in the AI explanation panel, per phase — this is
// the same number the "Route risk: 24 -> 71" callout is built from.
const RISK_BY_PHASE: Record<Phase, number> = {
  normal: 24,
  hazard: 71,
  rerouting: 71,
  resolved: 38,
  arrived: 12,
};

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function GlassPanel({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-slate-950/55 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-md ${className}`}
    >
      {children}
    </div>
  );
}

function WeatherCloud({ region }: { region: WeatherRegion }) {
  if (region.condition === 'clear') {
    return (
      <div
        className="pointer-events-none h-3 w-3 rounded-full"
        style={{ background: '#fde68a', boxShadow: '0 0 16px 6px rgba(253,230,138,0.55)' }}
      />
    );
  }

  const seed = seedFrom(region.id);
  const durA = 14 + (seed % 7); // 14–20s
  const durB = 18 + ((seed >> 3) % 9); // 18–26s
  const delay = (seed % 5) * -1.3; // negative delay so clouds start mid-cycle, not synced
  const blobCount = region.condition === 'storm' || region.condition === 'heavy-rain' ? 3 : 2;
  const baseSize = 34 + region.intensity * 46;
  const tint =
    region.condition === 'fog'
      ? 'rgba(226,232,240,0.5)'
      : region.condition === 'storm'
      ? 'rgba(100,116,139,0.65)'
      : region.condition === 'heavy-rain'
      ? 'rgba(71,85,105,0.6)'
      : 'rgba(148,163,184,0.5)';

  return (
    <div
      className="pointer-events-none relative"
      style={{ width: baseSize * 1.6, height: baseSize * 1.1 }}
    >
      {Array.from({ length: blobCount }).map((_, i) => (
        <div
          key={i}
          className={i % 2 === 0 ? 'samvahak-drift-a' : 'samvahak-drift-b'}
          style={{
            position: 'absolute',
            left: `${i * 22}%`,
            top: `${(i % 2) * 18}%`,
            width: baseSize - i * 6,
            height: (baseSize - i * 6) * 0.62,
            borderRadius: '9999px',
            background: tint,
            filter: `blur(${6 + region.intensity * 6}px)`,
            animationDuration: `${i % 2 === 0 ? durA : durB}s`,
            animationDelay: `${delay}s`,
            opacity: 0.5 + region.intensity * 0.4,
          }}
        />
      ))}
      {(region.condition === 'storm') && (
        <div
          className="samvahak-twinkle"
          style={{
            position: 'absolute',
            left: '38%',
            top: '48%',
            width: 2,
            height: 14,
            background: '#fde68a',
            boxShadow: '0 0 8px 2px rgba(253,230,138,0.8)',
            animationDelay: `${delay}s`,
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SamvahakLiveProps {
  mapboxToken?: string;
  primaryRoute?: LngLat[];
  alternativeRoute?: LngLat[];
  hazardFraction?: number;
  className?: string;
}

type LayerToggles = {
  weather: boolean;
  vehicles: boolean;
  shipments: boolean;
  incidents: boolean;
  routes: boolean;
  reports: boolean;
};

const DEFAULT_LAYERS: LayerToggles = {
  weather: true,
  vehicles: true,
  shipments: true,
  incidents: true,
  routes: true,
  reports: true,
};

export default function SamvahakLive({
  mapboxToken = DEFAULT_MAPBOX_TOKEN,
  primaryRoute = DEFAULT_PRIMARY_ROUTE,
  alternativeRoute = DEFAULT_ALTERNATIVE_ROUTE,
  hazardFraction = DEFAULT_HAZARD_FRACTION,
  className = '',
}: SamvahakLiveProps) {
  const mapRef = useRef<MapRef | null>(null);

  const [phase, setPhase] = useState<Phase>('normal');
  const [truckPos, setTruckPos] = useState<LngLat>(primaryRoute[0]);
  const [layers, setLayers] = useState<LayerToggles>(DEFAULT_LAYERS);
  const [originName, setOriginName] = useState('Imphal');
  const [destinationName, setDestinationName] = useState('Ukhrul');
  const [selected, setSelected] = useState<null | { type: 'vehicle' | 'incident' | 'report' }>(null);

  const phaseRef = useRef<Phase>('normal');
  const progressRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const hazardPoint = useMemo(() => pointAtFraction(primaryRoute, hazardFraction), [primaryRoute, hazardFraction]);

  const setPhaseBoth = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timeoutsRef.current.push(id);
  }, []);

  // --- Main animation loop --------------------------------------------------
  useEffect(() => {
    const tick = (now: number) => {
      if (lastTimeRef.current === null) lastTimeRef.current = now;
      const dt = Math.min((now - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = now;

      if (phaseRef.current === 'normal') {
        progressRef.current = Math.min(progressRef.current + dt * SPEED, hazardFraction);
        setTruckPos(pointAtFraction(primaryRoute, progressRef.current));

        if (progressRef.current >= hazardFraction) {
          setPhaseBoth('hazard');
          schedule(() => {
            setPhaseBoth('rerouting');
            schedule(() => {
              progressRef.current = 0;
              setPhaseBoth('resolved');
            }, REROUTE_REVEAL_MS);
          }, HAZARD_PAUSE_MS);
        }
      } else if (phaseRef.current === 'resolved') {
        progressRef.current = Math.min(progressRef.current + dt * SPEED, 1);
        setTruckPos(pointAtFraction(alternativeRoute, progressRef.current));

        if (progressRef.current >= 1) {
          setPhaseBoth('arrived');
          schedule(() => {
            progressRef.current = 0;
            setTruckPos(primaryRoute[0]);
            setPhaseBoth('normal');
          }, ARRIVAL_PAUSE_MS);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
    };
  }, [primaryRoute, alternativeRoute, hazardFraction, schedule, setPhaseBoth]);

  // --- Cinematic terrain + atmosphere setup ---------------------------------
  const handleMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    if (!map.getSource('mapbox-dem')) {
      map.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      });
    }
    // Enough exaggeration to read the hill corridor's depth without tipping
    // into a game-like relief.
    map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.2 });

    // Belt-and-braces: some react-map-gl versions don't forward the
    // `projection` prop into the underlying mapbox-gl instance on first
    // paint, so set it here too. This is what actually turns the flat
    // satellite map into a round, lit planet when zoomed out.
    if (typeof map.setProjection === 'function') {
      map.setProjection('globe');
    }

    if (!map.getLayer('sky')) {
      map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [120, 30],
          'sky-atmosphere-sun-intensity': 8,
          'sky-atmosphere-color': 'rgba(120, 160, 220, 1.0)',
          'sky-atmosphere-halo-color': 'rgba(255, 245, 220, 1.0)',
        },
      });
    }

    // Deep-space fog: dark space color, a soft blue atmospheric rim at the
    // horizon, and a faint star field — this is what sells the "orbit" feel
    // when the camera is pulled back.
    map.setFog({
      range: [0.5, 11],
      color: 'rgba(186, 210, 235, 0.35)',
      'high-color': 'rgba(36, 78, 168, 0.45)',
      'horizon-blend': 0.03,
      'space-color': 'rgba(4, 7, 15, 1)',
      'star-intensity': 0.25,
    });

    // Open from orbit, then glide down into the North-East corridor.
    map.jumpTo(ORBITAL_VIEW_STATE);
    schedule(() => {
      map.flyTo({ ...REGIONAL_VIEW_STATE, duration: 3600, curve: 1.3, essential: true });
    }, 300);
  }, [schedule]);

  const flyToRegional = useCallback(() => {
    mapRef.current?.getMap()?.flyTo({ ...REGIONAL_VIEW_STATE, duration: 1500, essential: true });
  }, []);

  const flyToPoint = useCallback((lng: number, lat: number) => {
    mapRef.current?.getMap()?.flyTo({ center: [lng, lat], zoom: 12.5, pitch: 60, duration: 1400, essential: true });
  }, []);

  // --- Derived GeoJSON -------------------------------------------------------
  const safeSegment = useMemo(() => toLineFeature(sliceUpToFraction(primaryRoute, hazardFraction)), [primaryRoute, hazardFraction]);

  const blockedSegment = useMemo(() => {
    const from = sliceUpToFraction(primaryRoute, hazardFraction);
    const rest = primaryRoute.slice(from.length - 1);
    return toLineFeature(rest.length > 1 ? rest : [from[from.length - 1], from[from.length - 1]]);
  }, [primaryRoute, hazardFraction]);

  const altFeature = useMemo(() => toLineFeature(alternativeRoute), [alternativeRoute]);

  const showBlocked = phase !== 'normal';
  const showAlternative = phase === 'rerouting' || phase === 'resolved' || phase === 'arrived';
  const showHazardMarker = phase !== 'normal';
  const truckIsOnAlt = phase === 'resolved' || phase === 'arrived';
  const risk = RISK_BY_PHASE[phase];
  const riskLevel = risk >= 60 ? 'HIGH' : risk >= 35 ? 'MODERATE' : 'LOW';
  const riskColor = risk >= 60 ? '#f87171' : risk >= 35 ? '#fbbf24' : '#34d399';

  // --- Layer paint helpers ---------------------------------------------------
  // Thin, elegant lines rather than heavy neon glow — an overlay that reads
  // as "navigation intelligence" sitting on real terrain, not a highlighter.
  const glowLine = (color: string, width = 1.6): LayerProps['paint'] => ({ 'line-color': color, 'line-width': width });
  const haloLine = (color: string, width = 7): LayerProps['paint'] => ({
    'line-color': color,
    'line-width': width,
    'line-blur': 5,
    'line-opacity': 0.35,
  });

  const { label, className: textClassName } = PHASE_TEXT[phase];

  const toggleLayer = (key: keyof LayerToggles) => setLayers((prev) => ({ ...prev, [key]: !prev[key] }));

  const controlItems: { key: keyof LayerToggles; icon: typeof Sun; label: string }[] = [
    { key: 'weather', icon: CloudRain, label: 'Weather' },
    { key: 'vehicles', icon: TruckIcon, label: 'Vehicles' },
    { key: 'shipments', icon: Package, label: 'Shipments' },
    { key: 'incidents', icon: AlertTriangle, label: 'Incidents' },
    { key: 'routes', icon: RouteIcon, label: 'Routes' },
    { key: 'reports', icon: MessageSquareWarning, label: 'Citizen Reports' },
  ];

  return (
    <div className={`relative h-full w-full overflow-hidden rounded-3xl bg-black ${className}`}>
      <style jsx global>{`
        @keyframes samvahak-drift-a {
          0% { transform: translate(0, 0) scale(1); opacity: 0.75; }
          50% { transform: translate(7px, -5px) scale(1.04); opacity: 0.95; }
          100% { transform: translate(0, 0) scale(1); opacity: 0.75; }
        }
        @keyframes samvahak-drift-b {
          0% { transform: translate(0, 0) scale(1); opacity: 0.6; }
          50% { transform: translate(-6px, 4px) scale(0.97); opacity: 0.85; }
          100% { transform: translate(0, 0) scale(1); opacity: 0.6; }
        }
        @keyframes samvahak-twinkle {
          0%, 100% { opacity: 0.15; }
          45%, 55% { opacity: 0.95; }
        }
        .samvahak-drift-a { animation-name: samvahak-drift-a; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
        .samvahak-drift-b { animation-name: samvahak-drift-b; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
        .samvahak-twinkle { animation-name: samvahak-twinkle; animation-duration: 2.4s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
      `}</style>

      <MapGL
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={ORBITAL_VIEW_STATE}
        mapStyle="mapbox://styles/mapbox/satellite-v9"
        projection="globe"
        onLoad={handleMapLoad}
        style={{ width: '100%', height: '100%' }}
        terrain={{ source: 'mapbox-dem', exaggeration: 1.2 }}
      >
        {layers.routes && (
          <>
            {/* Safe portion */}
            <Source id="safe-segment" type="geojson" data={safeSegment}>
              <MapLayer id="safe-halo" type="line" paint={haloLine('#e2e8f0', 8)} />
              <MapLayer id="safe-line" type="line" paint={glowLine('#f8fafc', 1.8)} />
            </Source>

            {/* Blocked portion */}
            {showBlocked && layers.incidents && (
              <Source id="blocked-segment" type="geojson" data={blockedSegment}>
                <MapLayer id="blocked-halo" type="line" paint={haloLine('#f87171', 8)} />
                <MapLayer
                  id="blocked-line"
                  type="line"
                  paint={glowLine('#ef4444', 1.8)}
                  layout={{ 'line-dasharray': [1.5, 1] }}
                />
              </Source>
            )}

            {/* Alternative corridor */}
            {showAlternative && (
              <Source id="alt-segment" type="geojson" data={altFeature}>
                <MapLayer id="alt-halo" type="line" paint={haloLine('#22d3ee', 9)} />
                <MapLayer id="alt-line" type="line" paint={glowLine('#67e8f9', 1.8)} />
              </Source>
            )}
          </>
        )}

        {/* Weather — region-anchored, not a blanket layer */}
        {layers.weather &&
          DEMO_WEATHER.map((region) => (
            <Marker key={region.id} longitude={region.lng} latitude={region.lat} anchor="center">
              <WeatherCloud region={region} />
            </Marker>
          ))}

        {/* Landslide incident marker */}
        {showHazardMarker && layers.incidents && (
          <Marker longitude={hazardPoint[0]} latitude={hazardPoint[1]} anchor="center">
            <button
              type="button"
              onClick={() => {
                setSelected({ type: 'incident' });
                flyToPoint(hazardPoint[0], hazardPoint[1]);
              }}
              className="relative flex h-5 w-5 cursor-pointer items-center justify-center"
              aria-label="Landslide incident"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-5 w-5 rounded-full bg-red-500 ring-2 ring-red-200" />
            </button>
          </Marker>
        )}

        {/* Citizen report */}
        {layers.reports && (
          <Marker longitude={DEMO_CITIZEN_REPORT.lng} latitude={DEMO_CITIZEN_REPORT.lat} anchor="center">
            <button
              type="button"
              onClick={() => setSelected({ type: 'report' })}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-amber-200/60 bg-amber-500/80 shadow-[0_0_10px_2px_rgba(245,158,11,0.6)]"
              aria-label="Citizen report"
            >
              <MessageSquareWarning size={13} className="text-slate-950" />
            </button>
          </Marker>
        )}

        {/* Truck / vehicle */}
        {layers.vehicles && (
          <Marker longitude={truckPos[0]} latitude={truckPos[1]} anchor="center">
            <button
              type="button"
              onClick={() => {
                setSelected({ type: 'vehicle' });
                flyToPoint(truckPos[0], truckPos[1]);
              }}
              className="block h-3.5 w-3.5 cursor-pointer rounded-full transition-colors duration-500"
              style={{
                background: truckIsOnAlt ? '#67e8f9' : '#f8fafc',
                boxShadow: truckIsOnAlt ? '0 0 14px 4px rgba(34,211,238,0.9)' : '0 0 14px 4px rgba(248,250,252,0.85)',
              }}
              aria-label="Vehicle NER-204"
            />
          </Marker>
        )}
      </MapGL>

      {/* Live feed status overlay */}
      <GlassPanel className="pointer-events-none absolute left-6 top-6 max-w-sm p-5">
        <p className="text-xs uppercase tracking-wide text-slate-400">Samvahak Live Feed</p>
        <p className={`mt-1.5 text-base font-medium leading-snug transition-colors duration-500 ${textClassName}`}>
          {label}
        </p>
        <p className="mt-3 text-xs text-slate-500">Route: {originName} to {destinationName} corridor</p>
      </GlassPanel>

      {/* AI route-risk explanation */}
      <GlassPanel className="absolute bottom-6 left-6 w-72 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-slate-400">Route Risk</p>
          <span className="text-[11px] font-semibold" style={{ color: riskColor }}>{riskLevel}</span>
        </div>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-100">{risk}<span className="text-base text-slate-500">/100</span></p>
        {phase !== 'normal' ? (
          <div className="mt-3 space-y-1.5 text-xs text-slate-300">
            <p className="text-slate-400">Why</p>
            <p>⛰ Landslide-prone hill corridor</p>
            <p>🌧 Rain building over nearby districts</p>
            {phase !== 'hazard' && <p className="text-cyan-300">→ Recommending Alternate Route B</p>}
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-500">All monitored segments nominal.</p>
        )}
      </GlassPanel>

      {/* Origin / destination */}
      <GlassPanel className="absolute bottom-6 right-6 w-64 p-4">
        <div className="space-y-2">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Origin</label>
            <input
              value={originName}
              onChange={(e) => setOriginName(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              const o = originName;
              setOriginName(destinationName);
              setDestinationName(o);
            }}
            className="mx-auto flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-400 hover:text-slate-100"
            aria-label="Swap origin and destination"
          >
            <ArrowUpDown size={12} />
          </button>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Destination</label>
            <input
              value={destinationName}
              onChange={(e) => setDestinationName(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
            />
          </div>
          <button
            type="button"
            onClick={flyToRegional}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg bg-cyan-500/90 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400"
          >
            <Navigation size={13} /> Calculate Route
          </button>
        </div>
      </GlassPanel>

      {/* Layer controls */}
      <GlassPanel className="absolute right-6 top-6 flex flex-col gap-1 p-1.5">
        {controlItems.map(({ key, icon: Icon, label: itemLabel }) => (
          <button
            key={key}
            type="button"
            onClick={() => toggleLayer(key)}
            title={itemLabel}
            className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
              layers[key] ? 'bg-white/10 text-cyan-300' : 'text-slate-600 hover:text-slate-300'
            }`}
          >
            <Icon size={15} />
          </button>
        ))}
      </GlassPanel>

      {/* Weather legend */}
      <GlassPanel className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-2">
        <div className="flex items-center gap-3">
          {(Object.keys(WEATHER_META) as WeatherCondition[]).map((cond) => {
            const meta = WEATHER_META[cond];
            const Icon = meta.icon;
            return (
              <div key={cond} className="flex items-center gap-1 text-[11px] text-slate-400">
                <Icon size={12} style={{ color: meta.color }} />
                <span className="hidden sm:inline">{meta.label}</span>
              </div>
            );
          })}
        </div>
      </GlassPanel>

      {/* Selected marker info card */}
      {selected && (
        <GlassPanel className="absolute left-1/2 top-6 w-72 -translate-x-1/2 p-4">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="absolute right-3 top-3 text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            <X size={14} />
          </button>

          {selected.type === 'vehicle' && (
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Vehicle</p>
              <p className="mt-0.5 text-lg font-semibold text-slate-100">NER-204</p>
              <dl className="mt-2 space-y-1 text-xs text-slate-300">
                <div className="flex justify-between"><dt className="text-slate-500">Cargo</dt><dd>Medicines</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Origin</dt><dd>{originName}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Destination</dt><dd>{destinationName}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd>{phase === 'arrived' ? 'Delivered' : 'In Transit'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">ETA</dt><dd>1h 42m</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Risk</dt><dd style={{ color: riskColor }}>{riskLevel}</dd></div>
              </dl>
            </div>
          )}

          {selected.type === 'incident' && (
            <div>
              <p className="text-xs uppercase tracking-wide text-amber-400">Landslide Detected</p>
              <dl className="mt-2 space-y-1 text-xs text-slate-300">
                <div className="flex justify-between"><dt className="text-slate-500">Location</dt><dd>Litan Corridor</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Severity</dt><dd className="text-red-400">HIGH</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Cause</dt><dd>Heavy Rainfall</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Expected Delay</dt><dd>+2h 15m</dd></div>
              </dl>
              <p className="mt-2 text-xs text-cyan-300">AI recommendation: Use Alternate Route B</p>
            </div>
          )}

          {selected.type === 'report' && (
            <div>
              <p className="text-xs uppercase tracking-wide text-amber-400">Citizen Report</p>
              <p className="mt-1.5 text-sm text-slate-200">{DEMO_CITIZEN_REPORT.message}</p>
              <p className="mt-2 text-[11px] text-slate-500">Demo data — connects to citizen reporting service.</p>
            </div>
          )}
        </GlassPanel>
      )}
    </div>
  );
}
