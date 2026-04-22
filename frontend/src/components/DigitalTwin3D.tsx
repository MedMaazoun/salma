import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Grid, Billboard } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  api,
  type ExitMode,
  type TraceEvent,
  type TraceLocation,
  type TraceLocationStats,
  type TraceResponse,
} from "../api";
import { Play, Pause, RotateCcw, Loader2, Sparkles } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

type PatientStatus = "moving" | "waiting" | "in_service" | "exited";

type PatientRuntime = {
  pid: number;
  status: PatientStatus;
  location: string | null;
  prevLocation: string | null;
  queueIndex: number;
  serviceIndex: number;
  moveStart: number;
  moveEnd: number;
  exitMode?: string;
  spawnedAt: number;
  exitedAt?: number;
  fromPortal: boolean;
  toPortal: boolean;
};

type RoomState = {
  queue: number[];
  service: number[];
};

const ROOM_W = 5.5;
const ROOM_D = 5.5;
const ROOM_H = 3;
const CORRIDOR_Z = 0;
const MOVE_DURATION_MIN = 3;
const ENTRY_Z = -22;
const EXIT_Z = 22;

const COLOR_WALL = "#2a3142";
const COLOR_ROOM_EMPTY = "#14b8a6";
const COLOR_ROOM_NEAR = "#f59e0b";
const COLOR_ROOM_FULL = "#ef4444";
const COLOR_ENTRY = "#22d3ee";
const COLOR_EXIT_HOME = "#22c55e";
const COLOR_EXIT_HOSP = "#fb923c";
const COLOR_EXIT_OTHER = "#94a3b8";
const COLOR_PATIENT_MOVE = "#22d3ee";
const COLOR_PATIENT_WAIT = "#f59e0b";
const COLOR_PATIENT_SERVICE = "#22c55e";

function patientColorForStatus(status: PatientStatus, exitMode?: string): string {
  if (status === "moving") return COLOR_PATIENT_MOVE;
  if (status === "waiting") return COLOR_PATIENT_WAIT;
  if (status === "in_service") return COLOR_PATIENT_SERVICE;
  if (exitMode?.includes("Hospitalisation")) return COLOR_EXIT_HOSP;
  if (exitMode?.includes("Retour")) return COLOR_EXIT_HOME;
  return COLOR_EXIT_OTHER;
}

function exitPortalXForMode(exitMode?: string): number {
  if (!exitMode) return 0;
  if (exitMode.includes("Hospitalisation")) return -6;
  if (exitMode.includes("Retour")) return 6;
  return 0;
}

function occupancyColor(nService: number, cap: number): string {
  const r = cap > 0 ? nService / cap : 0;
  if (r <= 0) return COLOR_ROOM_EMPTY;
  if (r < 0.8) return COLOR_ROOM_EMPTY;
  if (r < 1) return COLOR_ROOM_NEAR;
  return COLOR_ROOM_FULL;
}

function doorPos(loc: TraceLocation): [number, number, number] {
  const cx = loc.x;
  const cz = loc.y;
  const dz = cz > CORRIDOR_Z ? -ROOM_D / 2 : ROOM_D / 2;
  return [cx, 0, cz + dz];
}

function serviceSlot(loc: TraceLocation, idx: number): [number, number] {
  const cap = Math.max(1, loc.capacity);
  const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  const gap = 1.1;
  const x0 = loc.x - ((cols - 1) * gap) / 2;
  const z0 = loc.y - 0.5;
  return [x0 + c * gap, z0 + r * gap];
}

function queueSlot(loc: TraceLocation, idx: number): [number, number] {
  const cz = loc.y;
  const facingCorridor = cz > CORRIDOR_Z ? -1 : 1;
  const perRow = 5;
  const row = Math.floor(idx / perRow);
  const col = idx % perRow;
  const gap = 0.8;
  const doorX = loc.x;
  const doorZ = loc.y + facingCorridor * (ROOM_D / 2);
  const x = doorX - ((perRow - 1) * gap) / 2 + col * gap;
  const z = doorZ + facingCorridor * (0.9 + row * 0.8);
  return [x, z];
}

// ------------------ snapshot builder ------------------

type Snapshot = {
  patients: Map<number, PatientRuntime>;
  roomState: Map<string, RoomState>;
  treated: number;
  total: number;
  lastExitMode?: string;
};

function buildSnapshot(
  events: TraceEvent[],
  upTo: number,
  locById: Map<string, TraceLocation>,
): Snapshot {
  const patients = new Map<number, PatientRuntime>();
  const roomState = new Map<string, RoomState>();
  for (const id of locById.keys()) roomState.set(id, { queue: [], service: [] });
  let treated = 0;
  let total = 0;
  let lastExitMode: string | undefined;

  for (const e of events) {
    if (e.t > upTo) break;
    const loc = e.location;
    if (e.type === "arrive_queue" && loc) {
      let p = patients.get(e.patient_id);
      const firstArrival = !p;
      if (!p) {
        p = {
          pid: e.patient_id,
          status: "moving",
          location: null,
          prevLocation: null,
          queueIndex: -1,
          serviceIndex: -1,
          moveStart: e.t,
          moveEnd: e.t + MOVE_DURATION_MIN,
          spawnedAt: e.t,
          fromPortal: true,
          toPortal: false,
        };
        patients.set(e.patient_id, p);
        total++;
      }
      const rs = roomState.get(loc);
      if (rs) {
        rs.queue.push(e.patient_id);
        p.queueIndex = rs.queue.length - 1;
      }
      p.prevLocation = p.location;
      p.location = loc;
      p.status = "waiting";
      p.serviceIndex = -1;
      p.fromPortal = firstArrival;
    } else if (e.type === "start_service" && loc) {
      const p = patients.get(e.patient_id);
      const rs = roomState.get(loc);
      if (p && rs) {
        const qi = rs.queue.indexOf(e.patient_id);
        if (qi >= 0) rs.queue.splice(qi, 1);
        rs.service.push(e.patient_id);
        p.status = "in_service";
        p.queueIndex = -1;
        p.serviceIndex = rs.service.length - 1;
        p.fromPortal = false;
      }
    } else if (e.type === "depart" && loc) {
      const p = patients.get(e.patient_id);
      const rs = roomState.get(loc);
      if (p && rs) {
        const si = rs.service.indexOf(e.patient_id);
        if (si >= 0) rs.service.splice(si, 1);
        p.status = "moving";
        p.prevLocation = loc;
        p.location = null;
        p.moveStart = e.t;
        p.moveEnd = e.t + MOVE_DURATION_MIN;
        p.queueIndex = -1;
        p.serviceIndex = -1;
        p.fromPortal = false;
      }
    } else if (e.type === "exit") {
      const p = patients.get(e.patient_id);
      if (p) {
        // walk to exit portal first
        p.prevLocation = p.prevLocation ?? p.location;
        p.location = null;
        p.status = "moving";
        p.toPortal = true;
        p.moveStart = e.t;
        p.moveEnd = e.t + MOVE_DURATION_MIN;
        p.exitMode = e.exit_mode;
        p.exitedAt = e.t + MOVE_DURATION_MIN;
        treated++;
        lastExitMode = e.exit_mode;
      }
    }
  }
  for (const rs of roomState.values()) {
    rs.queue.forEach((pid, i) => {
      const p = patients.get(pid);
      if (p) p.queueIndex = i;
    });
    rs.service.forEach((pid, i) => {
      const p = patients.get(pid);
      if (p) p.serviceIndex = i;
    });
  }
  return { patients, roomState, treated, total, lastExitMode };
}

// ------------------ routing for movement ------------------

function corridorPath(
  from: TraceLocation | null,
  to: TraceLocation | null,
  fromPortal: boolean,
  toPortalInfo: { x: number; z: number } | null,
): [number, number][] {
  const pts: [number, number][] = [];
  if (fromPortal && !from) {
    pts.push([0, ENTRY_Z]);
    pts.push([0, CORRIDOR_Z]);
  } else if (from) {
    pts.push([from.x, from.y]);
    const [dx, , dz] = doorPos(from);
    pts.push([dx, dz]);
    pts.push([dx, CORRIDOR_Z]);
  }
  if (toPortalInfo) {
    pts.push([toPortalInfo.x, CORRIDOR_Z]);
    pts.push([toPortalInfo.x, toPortalInfo.z]);
  } else if (to) {
    const [dx2, , dz2] = doorPos(to);
    pts.push([dx2, CORRIDOR_Z]);
    pts.push([dx2, dz2]);
    pts.push([to.x, to.y]);
  }
  if (pts.length === 0) pts.push([0, 0]);
  return pts;
}

function interpPath(pts: [number, number][], u: number): [number, number] {
  if (pts.length === 1) return pts[0];
  const clamped = Math.max(0, Math.min(1, u));
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dz = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dz);
    lens.push(l);
    total += l;
  }
  if (total === 0) return pts[0];
  let target = clamped * total;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]) {
      const tt = lens[i] === 0 ? 0 : target / lens[i];
      const a = pts[i];
      const b = pts[i + 1];
      return [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt];
    }
    target -= lens[i];
  }
  return pts[pts.length - 1];
}

// ------------------ 3D components ------------------

function PatientMesh({
  x,
  z,
  color,
  opacity = 1,
  scale = 1,
}: {
  x: number;
  z: number;
  color: string;
  opacity?: number;
  scale?: number;
}) {
  return (
    <group position={[x, 0, z]} scale={scale}>
      <mesh position={[0, 0.4, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.3, 0.8, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.35}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </mesh>
      <mesh position={[0, 1.0, 0]} castShadow>
        <sphereGeometry args={[0.2, 14, 14]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.45}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </mesh>
    </group>
  );
}

function RoomWalls({ color, opacity }: { color: string; opacity: number }) {
  // 4 walls of thickness 0.12; door gap on the corridor-facing side.
  const t = 0.12;
  const h = ROOM_H;
  const doorW = 1.8;
  // back wall (opposite corridor)
  return (
    <>
      {/* back wall (full) */}
      <mesh position={[0, h / 2, -ROOM_D / 2]} castShadow receiveShadow>
        <boxGeometry args={[ROOM_W, h, t]} />
        <meshStandardMaterial color={COLOR_WALL} roughness={0.8} />
      </mesh>
      {/* front wall — split with door gap in the middle */}
      <mesh
        position={[-(ROOM_W - doorW) / 4 - doorW / 4, h / 2, ROOM_D / 2]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[(ROOM_W - doorW) / 2, h, t]} />
        <meshStandardMaterial color={COLOR_WALL} roughness={0.8} />
      </mesh>
      <mesh
        position={[(ROOM_W - doorW) / 4 + doorW / 4, h / 2, ROOM_D / 2]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[(ROOM_W - doorW) / 2, h, t]} />
        <meshStandardMaterial color={COLOR_WALL} roughness={0.8} />
      </mesh>
      {/* lintel over door */}
      <mesh position={[0, h - 0.3, ROOM_D / 2]} castShadow receiveShadow>
        <boxGeometry args={[doorW, 0.6, t]} />
        <meshStandardMaterial color={COLOR_WALL} roughness={0.8} />
      </mesh>
      {/* left wall */}
      <mesh position={[-ROOM_W / 2, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[t, h, ROOM_D]} />
        <meshStandardMaterial color={COLOR_WALL} roughness={0.8} />
      </mesh>
      {/* right wall */}
      <mesh position={[ROOM_W / 2, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[t, h, ROOM_D]} />
        <meshStandardMaterial color={COLOR_WALL} roughness={0.8} />
      </mesh>
      {/* floor tint */}
      <mesh position={[0, 0.05, 0]} receiveShadow>
        <boxGeometry args={[ROOM_W - 2 * t, 0.08, ROOM_D - 2 * t]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.25}
          transparent
          opacity={opacity}
        />
      </mesh>
    </>
  );
}

function Room({
  loc,
  nService,
  nQueue,
  facingSign,
}: {
  loc: TraceLocation;
  nService: number;
  nQueue: number;
  facingSign: number; // +1 if door faces +z, -1 otherwise
}) {
  const color = occupancyColor(nService, loc.capacity);
  const isExt = !!loc.is_extension;
  // Rotate so door faces corridor. If loc.y < 0, door is on +z side (facing corridor at z=0).
  const rotationY = facingSign > 0 ? 0 : Math.PI;
  return (
    <group position={[loc.x, 0, loc.y]}>
      <group rotation={[0, rotationY, 0]}>
        <RoomWalls color={color} opacity={0.35} />
      </group>
      <Billboard position={[0, ROOM_H + 1.1, 0]}>
        <mesh>
          <planeGeometry args={[ROOM_W * 0.9, 0.9]} />
          <meshBasicMaterial color="#0b1220" transparent opacity={0.85} />
        </mesh>
        <Text
          position={[0, 0.05, 0.01]}
          fontSize={0.38}
          color="#e2e8f0"
          anchorX="center"
          anchorY="middle"
          maxWidth={ROOM_W}
          textAlign="center"
        >
          {loc.name}
        </Text>
        <Text
          position={[0, -0.3, 0.01]}
          fontSize={0.28}
          color={color}
          anchorX="center"
          anchorY="middle"
        >
          {`${nService}/${loc.capacity}  •  file ${nQueue}`}
        </Text>
      </Billboard>
      {isExt && (
        <>
          <mesh position={[0, 0.02, 0]}>
            <ringGeometry args={[ROOM_W / 2 + 0.1, ROOM_W / 2 + 0.35, 64]} />
            <meshBasicMaterial color={COLOR_ENTRY} transparent opacity={0.55} side={THREE.DoubleSide} />
          </mesh>
          <Billboard position={[0, ROOM_H + 2.1, 0]}>
            <Text fontSize={0.34} color={COLOR_ENTRY} anchorX="center" anchorY="middle">
              + BOX ajouté
            </Text>
          </Billboard>
        </>
      )}
    </group>
  );
}

function GroupCluster({
  group,
  locs,
}: {
  group: string;
  locs: TraceLocation[];
}) {
  if (locs.length < 2) return null;
  const xs = locs.map((l) => l.x);
  const zs = locs.map((l) => l.y);
  const minX = Math.min(...xs) - ROOM_W / 2 - 0.6;
  const maxX = Math.max(...xs) + ROOM_W / 2 + 0.6;
  const minZ = Math.min(...zs) - ROOM_D / 2 - 0.6;
  const maxZ = Math.max(...zs) + ROOM_D / 2 + 0.6;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const hasExt = locs.some((l) => l.is_extension);
  const outlineColor = hasExt ? COLOR_ENTRY : "#475569";
  return (
    <group>
      {/* outline rectangle (thin frame on floor) */}
      <mesh position={[cx, 0.02, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.001, 0.001, 4]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      {/* 4 thin floor strips around the cluster */}
      {[
        { pos: [cx, 0.03, minZ] as [number, number, number], size: [w, 0.05, 0.15] as [number, number, number] },
        { pos: [cx, 0.03, maxZ] as [number, number, number], size: [w, 0.05, 0.15] as [number, number, number] },
        { pos: [minX, 0.03, cz] as [number, number, number], size: [0.15, 0.05, d] as [number, number, number] },
        { pos: [maxX, 0.03, cz] as [number, number, number], size: [0.15, 0.05, d] as [number, number, number] },
      ].map((s, i) => (
        <mesh key={i} position={s.pos}>
          <boxGeometry args={s.size} />
          <meshBasicMaterial color={outlineColor} transparent opacity={0.55} />
        </mesh>
      ))}
      <Billboard position={[cx, ROOM_H + 2.4, minZ + 0.2]}>
        <Text fontSize={0.52} color={outlineColor} anchorX="center" anchorY="middle">
          {`GROUPE ${group}`}
        </Text>
      </Billboard>
    </group>
  );
}

function CorridorSpine() {
  return (
    <>
      <mesh position={[0, 0.02, CORRIDOR_Z]}>
        <boxGeometry args={[50, 0.04, 2.6]} />
        <meshStandardMaterial color="#0b1220" emissive="#1e293b" emissiveIntensity={0.25} />
      </mesh>
      {/* dashed center line */}
      {Array.from({ length: 20 }, (_, i) => i - 10).map((i) => (
        <mesh key={i} position={[i * 2.4, 0.05, CORRIDOR_Z]}>
          <boxGeometry args={[1.1, 0.02, 0.12]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.55} />
        </mesh>
      ))}
    </>
  );
}

function Portal({
  x,
  z,
  color,
  label,
  sublabel,
  pulseRef,
}: {
  x: number;
  z: number;
  color: string;
  label: string;
  sublabel?: string;
  pulseRef?: React.MutableRefObject<number>;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!ringRef.current) return;
    const t = state.clock.getElapsedTime();
    const s = 1 + 0.15 * Math.sin(t * 2 + (pulseRef?.current ?? 0));
    ringRef.current.scale.set(s, s, s);
  });
  return (
    <group position={[x, 0, z]}>
      {/* base disc */}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.3, 2.1, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} side={THREE.DoubleSide} />
      </mesh>
      {/* outer pulse ring */}
      <mesh ref={ringRef} position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.2, 2.5, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.35} side={THREE.DoubleSide} />
      </mesh>
      {/* archway */}
      <mesh position={[-1.6, 1.4, 0]}>
        <boxGeometry args={[0.25, 2.8, 0.25]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[1.6, 1.4, 0]}>
        <boxGeometry args={[0.25, 2.8, 0.25]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[0, 2.85, 0]}>
        <boxGeometry args={[3.3, 0.25, 0.25]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <Billboard position={[0, 3.6, 0]}>
        <Text fontSize={0.62} color={color} anchorX="center" anchorY="middle">
          {label}
        </Text>
        {sublabel && (
          <Text position={[0, -0.55, 0]} fontSize={0.3} color="#cbd5e1" anchorX="center" anchorY="middle">
            {sublabel}
          </Text>
        )}
      </Billboard>
    </group>
  );
}

function Scene({
  locations,
  snapshot,
  currentTime,
  locById,
  maxPatients,
  lastExitMode,
}: {
  locations: TraceLocation[];
  snapshot: Snapshot;
  currentTime: number;
  locById: Map<string, TraceLocation>;
  maxPatients: number;
  lastExitMode?: string;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, TraceLocation[]>();
    for (const l of locations) {
      const g = l.group || l.id;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(l);
    }
    return m;
  }, [locations]);

  const visuals = useMemo(() => {
    const arr: {
      pid: number;
      x: number;
      z: number;
      color: string;
      opacity: number;
      scale: number;
    }[] = [];
    let count = 0;
    for (const p of snapshot.patients.values()) {
      if (count >= maxPatients) break;
      let x = 0;
      let z = 0;
      let opacity = 1;
      let scale = 1;

      // spawn fade-in (first 0.5 min after spawn)
      const sinceSpawn = currentTime - p.spawnedAt;
      if (sinceSpawn < 0.5) {
        const u = Math.max(0, Math.min(1, sinceSpawn / 0.5));
        scale = u;
        opacity = u;
      }

      if (p.status === "exited") {
        // fade out within 1 min of exit
        const since = currentTime - (p.exitedAt ?? 0);
        if (since > 1.0) continue;
        const u = Math.max(0, 1 - since / 1.0);
        opacity = u;
        scale = 0.5 + 0.5 * u;
        const portalX = exitPortalXForMode(p.exitMode);
        x = portalX;
        z = EXIT_Z;
      } else if (p.status === "in_service" && p.location) {
        const loc = locById.get(p.location);
        if (!loc) continue;
        const [sx, sz] = serviceSlot(loc, Math.max(0, p.serviceIndex));
        x = sx;
        z = sz;
      } else if (p.status === "waiting" && p.location) {
        const loc = locById.get(p.location);
        if (!loc) continue;
        const [sx, sz] = queueSlot(loc, Math.max(0, p.queueIndex));
        x = sx;
        z = sz;
      } else if (p.status === "moving") {
        const from = p.prevLocation ? locById.get(p.prevLocation) ?? null : null;
        const to = p.location ? locById.get(p.location) ?? null : null;
        const toPortal = p.toPortal
          ? { x: exitPortalXForMode(p.exitMode), z: EXIT_Z }
          : null;
        const pts = corridorPath(from, to, p.fromPortal, toPortal);
        const span = Math.max(0.001, p.moveEnd - p.moveStart);
        const u = Math.max(0, Math.min(1, (currentTime - p.moveStart) / span));
        const [xx, zz] = interpPath(pts, u);
        x = xx;
        z = zz;
      } else {
        continue;
      }
      arr.push({
        pid: p.pid,
        x,
        z,
        color: patientColorForStatus(p.status, p.exitMode),
        opacity,
        scale,
      });
      count++;
    }
    return arr;
  }, [snapshot, currentTime, locById, maxPatients]);

  return (
    <>
      <ambientLight intensity={0.4} color="#dbeafe" />
      <directionalLight
        position={[18, 28, 12]}
        intensity={1.05}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
      />
      <hemisphereLight args={["#93c5fd", "#0f172a", 0.35]} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#0a0f1c" roughness={0.95} />
      </mesh>
      <Grid
        position={[0, 0.01, 0]}
        args={[80, 80]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#1e293b"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#334155"
        fadeDistance={55}
        infiniteGrid={false}
      />

      <CorridorSpine />

      {/* Entry portal */}
      <Portal x={0} z={ENTRY_Z} color={COLOR_ENTRY} label="🚑 ARRIVÉE" sublabel="Entrée patients" />

      {/* Exit portals — three fixed lanes, highlighted by most recent exit */}
      <Portal
        x={-6}
        z={EXIT_Z}
        color={lastExitMode?.includes("Hospitalisation") ? COLOR_EXIT_HOSP : "#475569"}
        label="🏥 HOSPITALISATION"
        sublabel="Sur site"
      />
      <Portal
        x={0}
        z={EXIT_Z}
        color={lastExitMode && !lastExitMode.includes("Hospitalisation") && !lastExitMode.includes("Retour") ? COLOR_EXIT_OTHER : "#475569"}
        label="🔁 RÉORIENTATION"
        sublabel="Autre prise en charge"
      />
      <Portal
        x={6}
        z={EXIT_Z}
        color={lastExitMode?.includes("Retour") ? COLOR_EXIT_HOME : "#475569"}
        label="🏠 DOMICILE"
        sublabel="Retour"
      />

      {/* Group outlines (only when cluster has >= 2 rooms) */}
      {[...groups.entries()].map(([g, locs]) => (
        <GroupCluster key={g} group={g} locs={locs} />
      ))}

      {locations.map((loc) => {
        const rs = snapshot.roomState.get(loc.id);
        const facingSign = loc.y > CORRIDOR_Z ? -1 : 1;
        return (
          <Room
            key={loc.id}
            loc={loc}
            nService={rs?.service.length ?? 0}
            nQueue={rs?.queue.length ?? 0}
            facingSign={facingSign}
          />
        );
      })}

      {visuals.map((v) => (
        <PatientMesh
          key={v.pid}
          x={v.x}
          z={v.z}
          color={v.color}
          opacity={v.opacity}
          scale={v.scale}
        />
      ))}

      <EffectComposer>
        <Bloom intensity={0.55} luminanceThreshold={0.55} luminanceSmoothing={0.25} mipmapBlur />
      </EffectComposer>
    </>
  );
}

function ClockTicker({
  playing,
  speed,
  duration,
  currentTime,
  setCurrentTime,
}: {
  playing: boolean;
  speed: number;
  duration: number;
  currentTime: number;
  setCurrentTime: (t: number) => void;
}) {
  const tRef = useRef(currentTime);
  tRef.current = currentTime;
  useFrame((_, delta) => {
    if (!playing) return;
    const next = Math.min(duration, tRef.current + delta * speed);
    if (next !== tRef.current) {
      setCurrentTime(next);
    }
  });
  return null;
}

function formatMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ------------------ live stats derivation ------------------

type VisitSeg = {
  pid: number;
  arrive: number;
  start: number | null;
  depart: number | null;
};

type LocationEventLog = {
  id: string;
  name: string;
  capacity: number;
  visits: VisitSeg[];
  boundaries: { t: number; delta: number }[];
};

type PreprocessedTrace = {
  perLocation: Map<string, LocationEventLog>;
};

function preprocessTrace(trace: TraceResponse): PreprocessedTrace {
  const perLocation = new Map<string, LocationEventLog>();
  for (const loc of trace.locations) {
    perLocation.set(loc.id, {
      id: loc.id,
      name: loc.name,
      capacity: loc.capacity,
      visits: [],
      boundaries: [],
    });
  }
  const activeVisit = new Map<string, Map<number, VisitSeg>>();
  for (const loc of trace.locations) activeVisit.set(loc.id, new Map());

  for (const e of trace.events) {
    if (!e.location) continue;
    const log = perLocation.get(e.location);
    const actives = activeVisit.get(e.location);
    if (!log || !actives) continue;
    if (e.type === "arrive_queue") {
      const v: VisitSeg = { pid: e.patient_id, arrive: e.t, start: null, depart: null };
      log.visits.push(v);
      actives.set(e.patient_id, v);
    } else if (e.type === "start_service") {
      const v = actives.get(e.patient_id);
      if (v) {
        v.start = e.t;
        log.boundaries.push({ t: e.t, delta: 1 });
      }
    } else if (e.type === "depart") {
      const v = actives.get(e.patient_id);
      if (v) {
        v.depart = e.t;
        log.boundaries.push({ t: e.t, delta: -1 });
        actives.delete(e.patient_id);
      }
    }
  }
  for (const log of perLocation.values()) {
    log.boundaries.sort((a, b) => a.t - b.t);
  }
  return { perLocation };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function computeLiveStats(
  pre: PreprocessedTrace,
  T: number,
): TraceLocationStats[] {
  const out: TraceLocationStats[] = [];
  for (const log of pre.perLocation.values()) {
    const waits: number[] = [];
    let sumQueueArea = 0;
    let maxQueue = 0;
    let served = 0;
    let stillWaiting = 0;

    const queueEvents: { t: number; delta: number }[] = [];
    for (const v of log.visits) {
      if (v.arrive > T) continue;
      queueEvents.push({ t: v.arrive, delta: 1 });
      const outT = v.start !== null ? Math.min(v.start, T) : T;
      if (outT >= v.arrive) {
        queueEvents.push({ t: outT, delta: -1 });
      }
      const observedStart = v.start !== null && v.start <= T ? v.start : null;
      if (observedStart !== null) {
        waits.push(observedStart - v.arrive);
        served++;
      } else {
        stillWaiting++;
      }
    }
    queueEvents.sort((a, b) => a.t - b.t || b.delta - a.delta);
    let q = 0;
    let prevT = 0;
    for (const ev of queueEvents) {
      if (ev.t > T) break;
      sumQueueArea += q * (ev.t - prevT);
      q += ev.delta;
      if (q > maxQueue) maxQueue = q;
      prevT = ev.t;
    }
    if (prevT < T) sumQueueArea += q * (T - prevT);
    const avgQueue = T > 0 ? sumQueueArea / T : 0;

    let occ = 0;
    let satArea = 0;
    prevT = 0;
    for (const b of log.boundaries) {
      if (b.t > T) break;
      if (occ >= log.capacity && log.capacity > 0) {
        satArea += b.t - prevT;
      }
      occ += b.delta;
      prevT = b.t;
    }
    if (prevT < T && occ >= log.capacity && log.capacity > 0) {
      satArea += T - prevT;
    }
    const pctSat = T > 0 ? (satArea / T) * 100 : 0;

    const sortedWaits = [...waits].sort((a, b) => a - b);
    const avgWait = waits.length ? waits.reduce((s, x) => s + x, 0) / waits.length : 0;
    const maxWait = waits.length ? sortedWaits[sortedWaits.length - 1] : 0;
    const p90 = percentile(sortedWaits, 0.9);

    out.push({
      id: log.id,
      name: log.name,
      avg_queue_len: avgQueue,
      max_queue_len: maxQueue,
      avg_wait_min: avgWait,
      p90_wait_min: p90,
      max_wait_min: maxWait,
      pct_time_saturated: pctSat,
      served,
      still_waiting: stillWaiting,
    });
  }
  return out;
}

// ------------------ Stats panel ------------------

type SortKey = "avg_wait_min" | "avg_queue_len" | "max_queue_len" | "pct_time_saturated" | "served";

function StatsPanel({
  stats,
  timeseries,
  currentTime,
  duration,
  locById,
}: {
  stats: TraceLocationStats[];
  timeseries: TraceResponse["timeseries"];
  currentTime: number;
  duration: number;
  locById: Map<string, TraceLocation>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("avg_wait_min");
  const sorted = useMemo(() => {
    // keep siblings of a group together: primary sort by group, secondary by key
    return [...stats].sort((a, b) => {
      const la = locById.get(a.id);
      const lb = locById.get(b.id);
      const ga = la?.group || a.id;
      const gb = lb?.group || b.id;
      if (ga !== gb) return ga.localeCompare(gb);
      return (b[sortKey] as number) - (a[sortKey] as number);
    });
  }, [stats, sortKey, locById]);

  const chartData = useMemo(
    () =>
      timeseries.t
        .map((t, i) => ({
          t,
          file: timeseries.queue_total[i] ?? 0,
          service: timeseries.in_service_total[i] ?? 0,
        }))
        .filter((d) => d.t <= currentTime),
    [timeseries, currentTime],
  );

  const barData = useMemo(
    () =>
      [...stats]
        .sort((a, b) => b.avg_wait_min - a.avg_wait_min)
        .slice(0, 12)
        .map((s) => ({
          name: s.name.length > 14 ? s.name.slice(0, 13) + "…" : s.name,
          attente: s.avg_wait_min,
        })),
    [stats],
  );

  const isComplete = duration > 0 && currentTime >= duration;

  function sortBtn(key: SortKey, label: string) {
    return (
      <button
        onClick={() => setSortKey(key)}
        className={`text-left ${sortKey === key ? "text-cyan-300" : "text-slate-400 hover:text-slate-200"}`}
      >
        {label}
        {sortKey === key ? " ↓" : ""}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 px-2 py-1">
          <span>⏱</span>
          <span>
            t = {formatMin(currentTime)} / {formatMin(duration)}
          </span>
        </span>
        {isComplete && (
          <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 px-2 py-1">
            <span>✓</span>
            <span>Simulation complète</span>
          </span>
        )}
      </div>
      <div className="grid md:grid-cols-2 gap-4">
      <div className="card p-4 rounded-2xl border border-slate-700/60">
        <div className="text-xs uppercase text-slate-500 mb-2">Statistiques par lieu</div>
        <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead className="text-slate-400 sticky top-0 bg-slate-900/90 backdrop-blur">
              <tr className="border-b border-slate-700/60">
                <th className="text-left py-1 pr-2">Lieu</th>
                <th className="text-right py-1 pr-2">{sortBtn("avg_wait_min", "Attente moy")}</th>
                <th className="text-right py-1 pr-2">P90</th>
                <th className="text-right py-1 pr-2">Max</th>
                <th className="text-right py-1 pr-2">{sortBtn("avg_queue_len", "File moy")}</th>
                <th className="text-right py-1 pr-2">{sortBtn("max_queue_len", "File max")}</th>
                <th className="text-right py-1 pr-2">{sortBtn("pct_time_saturated", "% sat.")}</th>
                <th className="text-right py-1">{sortBtn("served", "Traités")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => {
                const l = locById.get(s.id);
                const isExt = !!l?.is_extension;
                return (
                  <tr key={s.id} className="border-b border-slate-800/60">
                    <td className="py-1 pr-2 text-slate-200 truncate max-w-[160px]">
                      {isExt && <span className="text-cyan-300 mr-1">+</span>}
                      {s.name}
                    </td>
                    <td className="py-1 pr-2 text-right text-amber-300">{s.avg_wait_min.toFixed(1)}</td>
                    <td className="py-1 pr-2 text-right text-slate-300">{s.p90_wait_min.toFixed(1)}</td>
                    <td className="py-1 pr-2 text-right text-slate-300">{s.max_wait_min.toFixed(1)}</td>
                    <td className="py-1 pr-2 text-right text-slate-300">{s.avg_queue_len.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-right text-slate-300">{s.max_queue_len}</td>
                    <td className="py-1 pr-2 text-right text-rose-300">{s.pct_time_saturated.toFixed(1)}%</td>
                    <td className="py-1 text-right text-emerald-300">{s.served}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <div className="card p-4 rounded-2xl border border-slate-700/60">
          <div className="text-xs uppercase text-slate-500 mb-2">
            File & service au cours du temps
          </div>
          <div style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[0, duration]}
                  allowDataOverflow
                  tick={{ fill: "#64748b", fontSize: 10 }}
                />
                <YAxis tick={{ fill: "#64748b", fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }}
                  labelFormatter={(l) => `t=${l} min`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine x={currentTime} stroke="#22d3ee" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="file" stroke="#f59e0b" dot={false} name="File totale" isAnimationActive={false} />
                <Line
                  type="monotone"
                  dataKey="service"
                  stroke="#22d3ee"
                  dot={false}
                  name="En service"
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card p-4 rounded-2xl border border-slate-700/60">
          <div className="text-xs uppercase text-slate-500 mb-2">Attente moyenne par lieu (min)</div>
          <div style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  angle={-25}
                  textAnchor="end"
                  interval={0}
                  height={40}
                />
                <YAxis tick={{ fill: "#64748b", fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }}
                />
                <Bar dataKey="attente" fill="#22d3ee" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// ------------------ Main component ------------------

type Mode = "sim" | "real";
type CameraPreset = "iso" | "top" | "entry";

export function DigitalTwin3D() {
  const [mode, setMode] = useState<Mode>("sim");
  const [extraBoxes, setExtraBoxes] = useState(0);
  const [arrivalMult, setArrivalMult] = useState(1.0);
  const [ioaSpeedup, setIoaSpeedup] = useState(0.0);
  const [durationHours, setDurationHours] = useState(6);

  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [replayExitMode, setReplayExitMode] = useState<string>("");
  const [exitModesList, setExitModesList] = useState<ExitMode[]>([]);

  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceMode, setTraceMode] = useState<Mode>("sim");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);

  const [sceneFade, setSceneFade] = useState(1);
  const [camPreset, setCamPreset] = useState<CameraPreset>("iso");

  async function generate() {
    setLoading(true);
    setErr(null);
    setPlaying(false);
    setCurrentTime(0);
    setSceneFade(0);
    try {
      const r = await api.simulateTrace({
        extra_boxes: extraBoxes,
        arrival_multiplier: arrivalMult,
        ioa_speedup: ioaSpeedup,
        duration_hours: durationHours,
      });
      setTrace(r);
      setTraceMode("sim");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
      // fade-in
      requestAnimationFrame(() => setSceneFade(1));
    }
  }

  async function loadReplay() {
    if (!dateFrom || !dateTo) {
      setErr("Veuillez choisir une fenêtre de dates.");
      return;
    }
    setLoading(true);
    setErr(null);
    setPlaying(false);
    setCurrentTime(0);
    setSceneFade(0);
    try {
      const r = await api.realTrace({
        date_from: dateFrom,
        date_to: dateTo,
        exit_mode: replayExitMode || null,
        top_locations: 8,
      });
      setTrace(r);
      setTraceMode("real");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => setSceneFade(1));
    }
  }

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.datasetRange();
        if (r.min) {
          setDateFrom(r.min);
          const d = new Date(r.min);
          d.setDate(d.getDate() + 1);
          setDateTo(d.toISOString().slice(0, 10));
        }
      } catch {}
      try {
        const em = await api.exitModes();
        setExitModesList(em);
      } catch {}
    })();
  }, []);

  const locById = useMemo(() => {
    const m = new Map<string, TraceLocation>();
    trace?.locations.forEach((l) => m.set(l.id, l));
    return m;
  }, [trace]);

  const snapshot = useMemo<Snapshot>(() => {
    if (!trace) return { patients: new Map(), roomState: new Map(), treated: 0, total: 0 };
    return buildSnapshot(trace.events, currentTime, locById);
  }, [trace, currentTime, locById]);

  const preprocessed = useMemo<PreprocessedTrace | null>(
    () => (trace ? preprocessTrace(trace) : null),
    [trace],
  );

  const [liveStatsT, setLiveStatsT] = useState(0);
  const lastComputedRef = useRef(0);
  useEffect(() => {
    if (!playing) {
      setLiveStatsT(currentTime);
      lastComputedRef.current = performance.now();
      return;
    }
    const now = performance.now();
    if (now - lastComputedRef.current >= 150) {
      lastComputedRef.current = now;
      setLiveStatsT(currentTime);
      return;
    }
    const remaining = 150 - (now - lastComputedRef.current);
    const h = window.setTimeout(() => {
      lastComputedRef.current = performance.now();
      setLiveStatsT(currentTime);
    }, remaining);
    return () => window.clearTimeout(h);
  }, [currentTime, playing]);

  const liveStats = useMemo<TraceLocationStats[]>(() => {
    if (!preprocessed) return [];
    return computeLiveStats(preprocessed, liveStatsT);
  }, [preprocessed, liveStatsT]);

  const inSystem = useMemo(() => {
    let n = 0;
    for (const p of snapshot.patients.values()) {
      if (p.status !== "exited") n++;
    }
    return n;
  }, [snapshot]);

  const waitingCount = useMemo(() => {
    let n = 0;
    for (const p of snapshot.patients.values()) {
      if (p.status === "waiting") n++;
    }
    return n;
  }, [snapshot]);

  const serviceCount = useMemo(() => {
    let n = 0;
    for (const p of snapshot.patients.values()) {
      if (p.status === "in_service") n++;
    }
    return n;
  }, [snapshot]);

  const bottleneck = useMemo(() => {
    if (!trace) return null;
    let best: { loc: TraceLocation; n: number } | null = null;
    for (const loc of trace.locations) {
      const n = snapshot.roomState.get(loc.id)?.queue.length ?? 0;
      if (!best || n > best.n) best = { loc, n };
    }
    return best;
  }, [trace, snapshot]);

  const duration = trace?.duration_min ?? 0;
  const speedOptions = [0.5, 1, 5, 50];

  const maxPatientsRender = 200;
  const hiddenPatients = Math.max(0, inSystem - maxPatientsRender);

  const cameraPosition: [number, number, number] =
    camPreset === "top" ? [0, 55, 0.01] : camPreset === "entry" ? [0, 12, -32] : [22, 24, 30];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-xs">
        <button
          onClick={() => setMode("sim")}
          className={`px-3 py-1.5 rounded-lg border transition ${
            mode === "sim"
              ? "bg-brand-500/20 border-brand-400 text-brand-200"
              : "border-slate-700 text-slate-400 hover:bg-slate-800"
          }`}
        >
          🧪 Simulation SimPy
        </button>
        <button
          onClick={() => setMode("real")}
          className={`px-3 py-1.5 rounded-lg border transition ${
            mode === "real"
              ? "bg-fuchsia-500/20 border-fuchsia-400 text-fuchsia-200"
              : "border-slate-700 text-slate-400 hover:bg-slate-800"
          }`}
        >
          📼 Replay réel (CSV)
        </button>
      </div>

      {mode === "sim" ? (
        <div className="card p-4 grid md:grid-cols-5 gap-4 items-end">
          <div className="text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Box sup.</span>
              <span className="text-brand-300">+{extraBoxes}</span>
            </div>
            <input
              type="range" min={0} max={5} step={1}
              value={extraBoxes}
              onChange={(e) => setExtraBoxes(Number(e.target.value))}
              className="w-full accent-brand-400"
            />
          </div>
          <div className="text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Arrivées</span>
              <span className="text-brand-300">{arrivalMult.toFixed(1)}×</span>
            </div>
            <input
              type="range" min={0.5} max={2} step={0.1}
              value={arrivalMult}
              onChange={(e) => setArrivalMult(Number(e.target.value))}
              className="w-full accent-brand-400"
            />
          </div>
          <div className="text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Accél. IOA</span>
              <span className="text-brand-300">{Math.round(ioaSpeedup * 100)}%</span>
            </div>
            <input
              type="range" min={0} max={0.5} step={0.05}
              value={ioaSpeedup}
              onChange={(e) => setIoaSpeedup(Number(e.target.value))}
              className="w-full accent-brand-400"
            />
          </div>
          <div className="text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Durée</span>
              <span className="text-brand-300">{durationHours} h</span>
            </div>
            <input
              type="range" min={1} max={48} step={1}
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              className="w-full accent-brand-400"
            />
          </div>
          <button
            onClick={generate}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-sky-500 hover:from-brand-400 hover:to-sky-400 text-slate-950 font-semibold px-4 py-2 transition disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {loading ? "Génération…" : "Générer la trace"}
          </button>
        </div>
      ) : (
        <div className="card p-4 grid md:grid-cols-4 gap-4 items-end">
          <div className="text-xs text-slate-400">
            <div className="mb-1">Date début</div>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200"
            />
          </div>
          <div className="text-xs text-slate-400">
            <div className="mb-1">Date fin (exclusive)</div>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200"
            />
          </div>
          <div className="text-xs text-slate-400">
            <div className="mb-1">Mode de sortie</div>
            <select
              value={replayExitMode}
              onChange={(e) => setReplayExitMode(e.target.value)}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200"
            >
              <option value="">Tous</option>
              {exitModesList.map((em) => (
                <option key={em.mode} value={em.mode}>
                  {em.mode} ({em.count})
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={loadReplay}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-rose-500 hover:from-fuchsia-400 hover:to-rose-400 text-slate-950 font-semibold px-4 py-2 transition disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <span>📼</span>}
            {loading ? "Chargement…" : "Charger le replay"}
          </button>
        </div>
      )}

      {err && <div className="card p-3 text-rose-300 text-sm">Erreur : {err}</div>}

      <div className="grid md:grid-cols-[1fr_260px] gap-4">
        <div
          className="card p-0 overflow-hidden relative rounded-2xl border border-slate-700/60"
          style={{ height: 640, background: "linear-gradient(180deg,#050914 0%,#0a1020 100%)" }}
        >
          {!trace || trace.locations.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm">
              {loading ? "Chargement de la trace…" : "Aucune donnée — cliquez sur « Générer la trace »."}
            </div>
          ) : (
            <>
              <div
                className="h-full w-full transition-opacity duration-500"
                style={{ opacity: sceneFade }}
              >
                <Canvas
                  shadows
                  camera={{ position: cameraPosition, fov: 45 }}
                  gl={{ antialias: true }}
                  onCreated={({ scene }) => {
                    scene.background = new THREE.Color("#060b18");
                    scene.fog = new THREE.Fog("#060b18", 45, 95);
                  }}
                >
                  <Scene
                    locations={trace.locations}
                    snapshot={snapshot}
                    currentTime={currentTime}
                    locById={locById}
                    maxPatients={maxPatientsRender}
                    lastExitMode={snapshot.lastExitMode}
                  />
                  <OrbitControls
                    enablePan
                    maxPolarAngle={Math.PI / 2.05}
                    minDistance={10}
                    maxDistance={90}
                  />
                  <ClockTicker
                    playing={playing}
                    speed={speed}
                    duration={duration}
                    currentTime={currentTime}
                    setCurrentTime={setCurrentTime}
                  />
                </Canvas>
              </div>

              {/* HUD — top-left digital clock */}
              <div className="absolute top-3 left-3 flex flex-col gap-2 pointer-events-none">
                <div className="bg-slate-900/75 border border-cyan-500/30 rounded-xl px-3 py-2 text-xs text-slate-200 backdrop-blur shadow-lg shadow-cyan-500/10">
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-400">⏱</span>
                    <span className="font-mono tabular-nums text-cyan-200 text-base tracking-wider">
                      {formatMin(currentTime)}
                    </span>
                    <span className="text-slate-500 font-mono text-xs">
                      / {formatMin(duration)}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wide">
                    {traceMode === "real" ? "Replay réel" : "Simulation SimPy"}
                  </div>
                </div>
                {trace.bottleneck_group && (trace.extra_boxes ?? 0) > 0 && (
                  <div className="bg-cyan-500/10 border border-cyan-400/40 rounded-xl px-3 py-2 text-[11px] text-cyan-200 backdrop-blur pointer-events-none">
                    + {trace.extra_boxes} box ajouté(s) à « {trace.bottleneck_group} »
                  </div>
                )}
              </div>

              {/* HUD — top-right live counters */}
              <div className="absolute top-3 right-3 bg-slate-900/75 border border-slate-700/60 rounded-xl px-3 py-2 text-xs text-slate-200 backdrop-blur shadow-lg">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 min-w-[170px]">
                  <span className="text-slate-400">Présents</span>
                  <span className="text-right font-semibold text-slate-100">{inSystem}</span>
                  <span className="text-slate-400">En attente</span>
                  <span className="text-right font-semibold text-amber-300">{waitingCount}</span>
                  <span className="text-slate-400">En soins</span>
                  <span className="text-right font-semibold text-emerald-300">{serviceCount}</span>
                  <span className="text-slate-400">Sortis</span>
                  <span className="text-right font-semibold text-cyan-300">{snapshot.treated}</span>
                </div>
                {hiddenPatients > 0 && (
                  <div className="mt-1 pt-1 border-t border-slate-700/60 text-[10px] text-slate-500">
                    +{hiddenPatients} non affichés
                  </div>
                )}
              </div>

              {/* HUD — bottom-left legend */}
              <div className="absolute bottom-14 left-3 bg-slate-900/75 border border-slate-700/60 rounded-xl px-3 py-2 text-[11px] text-slate-300 backdrop-blur space-y-1">
                <div className="text-[10px] uppercase text-slate-500 tracking-wide mb-1">Légende</div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-cyan-400" />
                  Déplacement / Arrivée
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-amber-400" />
                  En attente
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-emerald-400" />
                  En soins
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-orange-400" />
                  Hospitalisation
                </div>
              </div>

              {/* Camera presets */}
              <div className="absolute bottom-14 right-3 flex gap-1">
                {([
                  ["iso", "Vue d'ensemble"],
                  ["top", "Vue de haut"],
                  ["entry", "Depuis l'arrivée"],
                ] as [CameraPreset, string][]).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setCamPreset(k)}
                    className={`px-2 py-1 rounded-md text-[10px] border transition backdrop-blur ${
                      camPreset === k
                        ? "bg-cyan-500/20 border-cyan-400 text-cyan-200"
                        : "bg-slate-900/70 border-slate-700 text-slate-400 hover:bg-slate-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          {trace && trace.locations.length > 0 && (
            <div className="absolute bottom-0 left-0 right-0 bg-slate-900/85 border-t border-slate-700/60 backdrop-blur px-3 py-2 flex items-center gap-3">
              <button
                onClick={() => {
                  setPlaying(false);
                  setCurrentTime(0);
                }}
                className="p-1.5 rounded-lg text-slate-300 hover:bg-slate-800"
                aria-label="Reset"
              >
                <RotateCcw size={16} />
              </button>
              <button
                onClick={() => setPlaying((p) => !p)}
                className="p-1.5 rounded-lg bg-brand-500/80 hover:bg-brand-400 text-slate-950"
                aria-label="Play/Pause"
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <div className="flex gap-1">
                {speedOptions.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`px-2 py-1 rounded-md text-[11px] border transition ${
                      speed === s
                        ? "bg-brand-500/20 border-brand-400 text-brand-300"
                        : "border-slate-700 text-slate-400 hover:bg-slate-800"
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={0}
                max={duration}
                step={1}
                value={currentTime}
                onChange={(e) => {
                  setPlaying(false);
                  setCurrentTime(Number(e.target.value));
                }}
                className="flex-1 accent-brand-400"
              />
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="card p-4 rounded-2xl border border-slate-700/60">
            <div className="text-xs uppercase text-slate-500">Patients présents</div>
            <div className="text-2xl font-semibold text-slate-100">{inSystem}</div>
          </div>
          <div className="card p-4 rounded-2xl border border-slate-700/60">
            <div className="text-xs uppercase text-slate-500">Traités</div>
            <div className="text-2xl font-semibold text-emerald-300">
              {snapshot.treated}
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              Total passés: {snapshot.total}
            </div>
          </div>
          <div className="card p-4 rounded-2xl border border-slate-700/60">
            <div className="text-xs uppercase text-slate-500">Plus grande file</div>
            {bottleneck && bottleneck.n > 0 ? (
              <>
                <div className="text-sm font-semibold text-amber-300 truncate">
                  {bottleneck.loc.name}
                </div>
                <div className="text-[11px] text-slate-400">
                  {bottleneck.n} en attente
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">—</div>
            )}
          </div>
          <div className="card p-4 rounded-2xl border border-slate-700/60 text-[11px] text-slate-400 space-y-1">
            <div className="text-xs uppercase text-slate-500 mb-1">Portails</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-cyan-400" />
              Arrivée
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-emerald-400" />
              Sortie domicile
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-orange-400" />
              Hospitalisation
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-slate-400" />
              Réorientation
            </div>
          </div>
        </div>
      </div>

      {trace && trace.stats_per_location && (
        <StatsPanel
          stats={liveStats}
          timeseries={trace.timeseries}
          currentTime={liveStatsT}
          duration={duration}
          locById={locById}
        />
      )}
    </div>
  );
}
