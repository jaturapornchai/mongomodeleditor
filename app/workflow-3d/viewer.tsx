"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import "@babylonjs/loaders/glTF";
import type { Workflow, WorkflowDataAccess, WorkflowStep } from "../workflow";
import { workflowCityPositions, workflowEntry, workflowPath, workflowRoom } from "./world";

type CollectionOption = {
  id: string;
  label: string;
  diagramName: string;
  fields: { id: string; path: string; type: string }[];
};

type WorkflowPayload = {
  workflows: Workflow[];
  collections: CollectionOption[];
};

const KIND = {
  start: { label: "เริ่มต้น", hex: "#10b981" },
  action: { label: "ขั้นตอน", hex: "#0ea5e9" },
  decision: { label: "เงื่อนไข", hex: "#f59e0b" },
  end: { label: "สิ้นสุด", hex: "#8b5cf6" },
} satisfies Record<WorkflowStep["kind"], { label: string; hex: string }>;

const OPERATION: Record<WorkflowDataAccess["operation"], string> = {
  read: "อ่าน",
  create: "สร้าง",
  update: "แก้ไข",
  delete: "ลบ",
};

const shortLabel = (value: string) => value.length > 22 ? `${value.slice(0, 21)}…` : value;

function sceneMaterial(scene: Scene, name: string, diffuse: string, emissive = "#000000") {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.FromHexString(diffuse);
  material.emissiveColor = Color3.FromHexString(emissive);
  material.specularColor = new Color3(0.15, 0.2, 0.3);
  return material;
}

function createSign(
  scene: Scene,
  text: string,
  color: string,
  position: Vector3,
  width = 2.35,
  height = 0.54,
  fontSize = 96,
) {
  const texture = new DynamicTexture(`sign-${text}`, { width: 1024, height: 256 }, scene, true);
  const label = shortLabel(text);
  const context = texture.getContext();
  const minimum = Math.max(48, Math.floor(fontSize * 0.62));
  let fitted = fontSize;
  while (fitted > minimum) {
    context.font = `700 ${fitted}px system-ui, sans-serif`;
    if (context.measureText(label).width <= 900) break;
    fitted -= 4;
  }
  texture.drawText(label, null, 172, `700 ${fitted}px system-ui, sans-serif`, color, "#07101f", true);
  const material = new StandardMaterial(`sign-material-${text}`, scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = Color3.White();
  material.disableLighting = true;
  const sign = CreatePlane(`sign-${text}`, { width, height }, scene);
  sign.position.copyFrom(position);
  sign.material = material;
  sign.billboardMode = TransformNode.BILLBOARDMODE_ALL;
  sign.isPickable = false;
  return sign;
}

type AnimatedCitizen = {
  root: AbstractMesh;
  idle: AnimationGroup | null;
  walk: AnimationGroup | null;
  walking: boolean;
  groundY: number;
};

function WorkflowCity({
  workflow,
  currentId,
  route,
  onTravel,
  onArrive,
}: {
  workflow: Workflow;
  currentId: string;
  route: string[];
  onTravel: (target: string) => void;
  onArrive: (target: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positions = useMemo(() => workflowCityPositions(workflow), [workflow]);
  const citizenRef = useRef<AnimatedCitizen | null>(null);
  const travelRef = useRef<{ points: Vector3[]; index: number; target: string } | null>(null);
  const currentRef = useRef(currentId);
  const onTravelRef = useRef(onTravel);
  const onArriveRef = useRef(onArrive);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    onTravelRef.current = onTravel;
    onArriveRef.current = onArrive;
  }, [onArrive, onTravel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true });
    engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.012, 0.027, 0.07, 1);
    scene.imageProcessingConfiguration.exposure = 1.12;
    scene.imageProcessingConfiguration.contrast = 1.18;
    const points = [...positions.values()];
    const xs = points.map((point) => point.x);
    const zs = points.map((point) => point.z);
    const width = Math.max(12, Math.max(...xs) - Math.min(...xs) + 8);
    const depth = Math.max(12, Math.max(...zs) - Math.min(...zs) + 8);
    const radius = Math.max(12, Math.hypot(width, depth) * 0.62);
    const camera = new ArcRotateCamera("city-camera", -Math.PI / 2.35, 0.9, radius, new Vector3(0, 0.45, 0), scene);
    camera.minZ = 0.1;
    camera.lowerRadiusLimit = Math.max(5, radius * 0.28);
    camera.upperRadiusLimit = radius * 3;
    camera.lowerBetaLimit = 0.35;
    camera.upperBetaLimit = 1.28;
    camera.wheelPrecision = 48;
    camera.panningSensibility = 85;
    camera.inertia = 0.78;
    camera.panningInertia = 0.75;
    camera.attachControl(false, false, 2);

    const skyLight = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
    skyLight.intensity = 0.64;
    skyLight.diffuse = new Color3(0.65, 0.78, 1);
    const sun = new DirectionalLight("flow-sun", new Vector3(-0.65, -1.35, -0.55), scene);
    sun.position.copyFromFloats(width * 0.35, 14, -depth * 0.35);
    sun.intensity = 1.45;
    const fillLight = new PointLight("flow-fill", new Vector3(0, 7, 0), scene);
    fillLight.intensity = 2.5;
    fillLight.range = Math.max(width, depth) * 1.5;
    const shadows = new ShadowGenerator(1024, sun);
    shadows.useBlurExponentialShadowMap = true;
    shadows.blurKernel = 16;
    shadows.bias = 0.0005;
    const glow = new GlowLayer("workflow-glow", scene, { mainTextureRatio: 0.35 });
    glow.intensity = 0.34;

    const gridTexture = new DynamicTexture("flow-floor", { width: 128, height: 128 }, scene, false);
    const grid = gridTexture.getContext();
    grid.fillStyle = "#07101f";
    grid.fillRect(0, 0, 128, 128);
    grid.strokeStyle = "rgba(34,211,238,.10)";
    grid.lineWidth = 1;
    grid.beginPath();
    grid.moveTo(0, 0.5);
    grid.lineTo(128, 0.5);
    grid.moveTo(0.5, 0);
    grid.lineTo(0.5, 128);
    grid.stroke();
    gridTexture.wrapU = Texture.WRAP_ADDRESSMODE;
    gridTexture.wrapV = Texture.WRAP_ADDRESSMODE;
    gridTexture.uScale = width / 2;
    gridTexture.vScale = depth / 2;
    gridTexture.update(false);
    const groundMaterial = sceneMaterial(scene, "flow-ground", "#07101f");
    groundMaterial.diffuseTexture = gridTexture;
    groundMaterial.specularColor = new Color3(0.1, 0.32, 0.42);
    const ground = CreateGround("flow-ground", { width, height: depth }, scene);
    ground.material = groundMaterial;
    ground.isPickable = false;
    ground.receiveShadows = true;

    const roadMaterial = sceneMaterial(scene, "workflow-links", "#164e63", "#083344");
    roadMaterial.alpha = 0.72;
    const routeMaterial = sceneMaterial(scene, "workflow-route-light", "#22d3ee", "#67e8f9");
    const pulseMaterial = sceneMaterial(scene, "workflow-pulse", "#e0f2fe", "#67e8f9");
    const signs: AbstractMesh[] = [];
    const flowParticles: { mesh: AbstractMesh; source: Vector3; target: Vector3; offset: number }[] = [];
    for (const transition of workflow.transitions) {
      const source = positions.get(transition.source);
      const target = positions.get(transition.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dz = target.z - source.z;
      const length = Math.hypot(dx, dz);
      if (length === 0) continue;
      const path = [new Vector3(source.x, 0.08, source.z), new Vector3(target.x, 0.08, target.z)];
      const road = CreateTube(`link-${transition.id}`, { path, radius: 0.11, tessellation: 16 }, scene);
      road.material = roadMaterial;
      road.isPickable = false;
      const line = CreateTube(`route-${transition.id}`, { path, radius: 0.035, tessellation: 12 }, scene);
      line.material = routeMaterial;
      line.isPickable = false;
      const arrow = CreateCylinder(`arrow-${transition.id}`, { height: 0.42, diameterTop: 0, diameterBottom: 0.28, tessellation: 16 }, scene);
      arrow.position.copyFrom(Vector3.Lerp(path[0], path[1], 0.78));
      arrow.position.y = 0.13;
      arrow.rotation.copyFromFloats(Math.PI / 2, Math.atan2(dx, dz), 0);
      arrow.material = routeMaterial;
      arrow.isPickable = false;
      const particle = CreateSphere(`pulse-${transition.id}`, { diameter: 0.14, segments: 10 }, scene);
      particle.material = pulseMaterial;
      particle.isPickable = false;
      flowParticles.push({
        mesh: particle,
        source: path[0],
        target: path[1],
        offset: flowParticles.length / Math.max(1, workflow.transitions.length),
      });
      const label = transition.label?.trim() || transition.condition?.trim();
      if (label) signs.push(createSign(scene, `→ ${label}`, "#67e8f9", new Vector3((source.x + target.x) / 2, 0.5, (source.z + target.z) / 2), 1.35, 0.34, 72));
    }

    const stationMaterial = sceneMaterial(scene, "step-core", "#0f172a", "#020617");
    const nodeMaterials = new Map<string, { material: StandardMaterial; color: Color3 }>();
    for (const step of workflow.steps) {
      const point = positions.get(step.id);
      if (!point) continue;
      const meta = KIND[step.kind];
      const color = Color3.FromHexString(meta.hex);
      const material = sceneMaterial(scene, `step-${step.id}`, meta.hex, meta.hex);
      material.emissiveColor = color.scale(step.id === currentRef.current ? 0.46 : 0.12);
      material.alpha = 0.88;
      nodeMaterials.set(step.id, { material, color });
      const ring = CreateCylinder(`step-ring-${step.id}`, { height: 0.035, diameter: 1.72, tessellation: 48 }, scene);
      ring.position.copyFromFloats(point.x, 0.025, point.z);
      ring.material = material;
      ring.metadata = { stepId: step.id };
      const pad = CreateCylinder(`step-pad-${step.id}`, {
        height: 0.18,
        diameter: 1.3,
        tessellation: step.kind === "decision" ? 4 : step.kind === "action" ? 8 : 12,
      }, scene);
      pad.position.copyFromFloats(point.x, 0.11, point.z);
      if (step.kind === "decision") pad.rotation.y = Math.PI / 4;
      pad.material = stationMaterial;
      pad.metadata = { stepId: step.id };
      pad.receiveShadows = true;
      const beacon = CreateSphere(`step-beacon-${step.id}`, { diameter: 0.34, segments: 18 }, scene);
      beacon.position.copyFromFloats(point.x, 0.58, point.z);
      beacon.material = material;
      beacon.metadata = { stepId: step.id };
      signs.push(createSign(scene, step.title, "#f8fafc", new Vector3(point.x, 1.12, point.z), 2.35, 0.54, 96));
    }
    let citizen: AnimatedCitizen | null = null;
    let disposed = false;
    const loadModels = async () => {
      const robotResult = await ImportMeshAsync("/3d/office/robot.glb", scene);
      if (disposed) return;
      const robot = robotResult.meshes[0];
      robot.scaling.setAll(0.38);
      robot.rotationQuaternion = null;
      robot.rotation.y = 0;
      robot.position.setAll(0);
      robot.computeWorldMatrix(true);
      const robotBounds = robot.getHierarchyBoundingVectors(true);
      const initial = positions.get(currentRef.current) ?? points[0];
      const groundY = -robotBounds.min.y + 0.2;
      robot.position.copyFromFloats(initial.x, groundY, initial.z);
      for (const mesh of robotResult.meshes) {
        mesh.isPickable = false;
        shadows.addShadowCaster(mesh);
      }
      for (const group of robotResult.animationGroups) group.stop();
      const idle = robotResult.animationGroups.find((group) => group.name.toLowerCase() === "idle") ?? null;
      const walk = robotResult.animationGroups.find((group) => group.name.toLowerCase() === "walking") ?? null;
      idle?.start(true, 1);
      citizen = { root: robot, idle, walk, walking: false, groundY };
      citizenRef.current = citizen;
      setReady(true);
    };
    void loadModels().catch((reason: unknown) => {
      if (!disposed) setLoadError(reason instanceof Error ? reason.message : "โหลดโมเดล 3D ไม่สำเร็จ");
    });

    let pointerStart: { x: number; y: number } | null = null;
    const onResize = () => engine.resize();
    const onPointerDown = (event: PointerEvent) => {
      pointerStart = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = pointerStart;
      pointerStart = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const stepId = scene.pick(event.offsetX, event.offsetY)?.pickedMesh?.metadata?.stepId;
      if (typeof stepId === "string") onTravelRef.current(stepId);
    };
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("resize", onResize);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", preventContextMenu);

    const direction = Vector3.Zero();
    let elapsed = 0;
    const setWalking = (walking: boolean) => {
      if (!citizen || citizen.walking === walking) return;
      citizen.idle?.stop();
      citizen.walk?.stop();
      (walking ? citizen.walk : citizen.idle)?.start(true, walking ? 1.15 : 1);
      citizen.walking = walking;
    };
    scene.onBeforeRenderObservable.add(() => {
      elapsed += Math.min(0.05, engine.getDeltaTime() / 1000);
      for (const [id, item] of nodeMaterials)
        item.material.emissiveColor = item.color.scale(id === currentRef.current ? 0.46 + Math.sin(elapsed * 4) * 0.12 : 0.12);
      for (const particle of flowParticles) {
        const progress = (elapsed * 0.28 + particle.offset) % 1;
        Vector3.LerpToRef(particle.source, particle.target, progress, particle.mesh.position);
        particle.mesh.position.y = 0.16 + Math.sin(progress * Math.PI) * 0.08;
      }
      for (const sign of signs)
        sign.scaling.setAll(Math.min(1.65, Math.max(1, Vector3.Distance(camera.position, sign.position) / 16)));
      const travel = travelRef.current;
      if (!citizen || !travel) {
        setWalking(false);
        return;
      }
      setWalking(true);
      const target = travel.points[travel.index];
      target.subtractToRef(citizen.root.position, direction);
      direction.y = 0;
      const distance = direction.length();
      const movement = Math.min(0.05, engine.getDeltaTime() / 1000) * 2.6;
      if (distance <= movement) {
        citizen.root.position.copyFrom(target);
        travel.index += 1;
        if (travel.index >= travel.points.length) {
          travelRef.current = null;
          setWalking(false);
          onArriveRef.current(travel.target);
        }
        return;
      }
      direction.scaleInPlace(1 / distance);
      citizen.root.rotation.y = Math.atan2(direction.x, direction.z);
      citizen.root.position.addInPlace(direction.scaleInPlace(movement));
    });
    engine.runRenderLoop(() => scene.render());

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", preventContextMenu);
      camera.detachControl();
      scene.dispose();
      engine.dispose();
      citizenRef.current = null;
    };
  }, [positions, workflow]);

  useEffect(() => {
    currentRef.current = currentId;
    if (!route.length) {
      const point = positions.get(currentId);
      const citizen = citizenRef.current;
      if (point && citizen)
        citizen.root.position.copyFromFloats(point.x, citizen.groundY, point.z);
    }
  }, [currentId, positions, route.length]);

  useEffect(() => {
    if (route.length < 2) {
      travelRef.current = null;
      return;
    }
    const points = route.slice(1).flatMap((id) => {
      const point = positions.get(id);
      return point ? [new Vector3(point.x, citizenRef.current?.groundY ?? 0, point.z)] : [];
    });
    const target = route.at(-1);
    if (points.length && target) travelRef.current = { points, index: 0, target };
  }, [positions, route]);

  return (
    <div className="absolute inset-0 bg-slate-950">
      <canvas ref={canvasRef} className="h-full w-full touch-none outline-none" tabIndex={0} aria-label="แผนที่ Workflow สามมิติมุมสูง ลากซ้ายเพื่อหมุน ลากขวาเพื่อเลื่อน หมุนล้อเมาส์เพื่อซูม และคลิก Step ให้ตัวละครเดิน" />
      {!ready && !loadError && <div className="absolute inset-0 grid place-items-center bg-slate-950 text-sm text-cyan-300">กำลังโหลด Flow และตัวละคร…</div>}
      {loadError && <div className="absolute inset-0 grid place-items-center bg-slate-950/90 p-6 text-center text-sm text-red-300">⚠️ โหลดโมเดล 3D ไม่สำเร็จ<br />{loadError}</div>}
      {ready && (
        <div className="pointer-events-none absolute bottom-24 right-4 rounded-xl border border-white/10 bg-slate-950/72 px-3 py-2 text-[11px] text-slate-300 backdrop-blur">
          ลากซ้าย หมุน · ลากขวา เลื่อน · ล้อเมาส์ ซูม · คลิก Step เดิน
        </div>
      )}
    </div>
  );
}

export default function Workflow3DViewer({
  project,
  workflowId,
  initialStep,
}: {
  project: string;
  workflowId: string;
  initialStep?: string;
}) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [route, setRoute] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const [error, setError] = useState(() =>
    !project || !workflowId ? "[INVALID_ARGUMENT] URL ต้องมี project และ workflow" : "",
  );
  const travelMode = useRef<"forward" | "back">("forward");

  useEffect(() => {
    if (!project || !workflowId) return;
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(project)}/workflows`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as WorkflowPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "โหลด Workflow ไม่สำเร็จ");
      const found = body.workflows.find((item) => item.id === workflowId);
      if (!found) throw new Error(`[WORKFLOW_NOT_FOUND] ไม่พบ workflow "${workflowId}"`);
      const entry = workflowEntry(found, initialStep);
      if (!entry) throw new Error("[WORKFLOW_EMPTY] Workflow ยังไม่มีขั้นตอน");
      setCollections(body.collections ?? []);
      setWorkflow(found);
      setCurrentId(entry);
      setHistory([]);
      setRoute([]);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "โหลด Workflow ไม่สำเร็จ");
    });
    return () => controller.abort();
  }, [initialStep, project, workflowId]);

  const current = useMemo(
    () => workflow && currentId ? workflowRoom(workflow, currentId) : null,
    [currentId, workflow],
  );
  const collectionById = useMemo(
    () => new Map(collections.map((collection) => [collection.id, collection])),
    [collections],
  );
  const visited = useMemo(() => new Set([...history, currentId]).size, [currentId, history]);
  const transitioning = route.length > 1;

  const go = useCallback((target: string) => {
    if (!workflow || transitioning || target === currentId) return;
    const path = workflowPath(workflow, currentId, target);
    if (!path) {
      setMessage("ไม่มีถนน Workflow เชื่อมไปยัง Step นี้");
      return;
    }
    setMessage("");
    travelMode.current = "forward";
    setRoute(path);
  }, [currentId, transitioning, workflow]);

  const arrive = useCallback((target: string) => {
    if (travelMode.current === "back") setHistory((items) => items.slice(0, -1));
    else setHistory((items) => [...items, currentId].slice(-100));
    setCurrentId(target);
    setRoute([]);
  }, [currentId]);

  const goBack = () => {
    const previous = history.at(-1);
    if (!workflow || !previous || transitioning) return;
    const path = workflowPath(workflow, currentId, previous);
    if (!path) return;
    travelMode.current = "back";
    setRoute(path);
  };

  if (error)
    return (
      <main className="grid h-screen place-items-center bg-slate-950 p-6 text-slate-200">
        <div className="max-w-xl rounded-2xl border border-red-500/25 bg-red-500/8 p-6 text-center">
          <div className="text-3xl">⚠️</div>
          <h1 className="mt-3 text-lg font-semibold">เปิด Workflow 3D ไม่สำเร็จ</h1>
          <p className="mt-2 break-words text-sm text-red-300">{error}</p>
          <button className="mm-btn mt-5" onClick={() => window.close()}>ปิดหน้านี้</button>
        </div>
      </main>
    );

  if (!workflow || !current)
    return <main className="grid h-screen place-items-center bg-slate-950 text-sm text-cyan-300">กำลังโหลด Workflow 3D…</main>;

  const meta = KIND[current.step.kind];
  return (
    <main className="relative h-screen overflow-hidden bg-slate-950 text-slate-100">
      <WorkflowCity workflow={workflow} currentId={currentId} route={route} onTravel={go} onArrive={arrive} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_68%,rgba(15,23,42,.28)_100%)]" />

      <header className="pointer-events-auto absolute inset-x-0 top-0 z-20 flex items-center gap-3 border-b border-white/10 bg-slate-950/72 px-4 py-3 backdrop-blur-xl">
        <button className="mm-btn" onClick={() => window.close()}>← กลับผัง 2D</button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">🧭 {workflow.name}</div>
          <div className="truncate text-[11px] text-slate-400">{project}</div>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <button className="mm-btn" onClick={() => setShowDetails((value) => !value)}>ℹ {showDetails ? "ซ่อนข้อมูล" : "รายละเอียด"}</button>
          {!!current.step.dataAccess?.length && <button className="mm-btn" onClick={() => setShowSchema((value) => !value)}>▣ Schema</button>}
          <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-slate-300">สำรวจ {visited}/{workflow.steps.length}</span>
          {transitioning && <span className="rounded-full bg-cyan-400/12 px-3 py-1.5 text-cyan-200">🚶 กำลังเดิน</span>}
          <button className="mm-btn" disabled={!history.length || transitioning} onClick={goBack}>↶ ขั้นก่อนหน้า</button>
        </div>
      </header>

      {message && <div className="pointer-events-none absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-full border border-amber-400/25 bg-slate-950/85 px-4 py-2 text-xs text-amber-200 backdrop-blur">{message}</div>}

      <section className="pointer-events-auto absolute left-4 top-20 z-10 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-slate-950/78 p-3 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: meta.hex }}>
          <span className="h-2 w-2 rounded-full shadow-[0_0_12px_currentColor]" style={{ background: meta.hex }} />
          {meta.label}
          {current.step.actor && <span className="ml-auto rounded-full bg-white/7 px-2 py-1 font-normal text-slate-300">{current.step.actor}</span>}
        </div>
        <h1 className="mt-1.5 text-base font-semibold text-white">{current.step.title}</h1>
        {showDetails && <>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">{current.step.description}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {current.step.api && <span className="rounded-lg border border-violet-400/20 bg-violet-400/10 px-2 py-1 text-violet-200">{current.step.api.method} {current.step.api.path}</span>}
            {!!current.step.inputs?.length && <span className="rounded-lg bg-sky-400/10 px-2 py-1 text-sky-200">ข้อมูลเข้า {current.step.inputs.length}</span>}
            {!!current.step.outputs?.length && <span className="rounded-lg bg-emerald-400/10 px-2 py-1 text-emerald-200">ข้อมูลออก {current.step.outputs.length}</span>}
          </div>
        </>}
      </section>

      {showSchema && !!current.step.dataAccess?.length && (
        <aside className="pointer-events-auto absolute right-4 top-20 z-10 hidden max-h-[55vh] w-80 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/76 p-4 shadow-2xl backdrop-blur-xl md:block">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-fuchsia-200">▣ Schema ที่ใช้ในขั้นตอนนี้</h2>
            <button className="ml-auto text-xs text-slate-400 hover:text-white" onClick={() => setShowSchema(false)}>✕</button>
          </div>
          <div className="mt-3 space-y-2">
            {current.step.dataAccess.map((access, index) => {
              const collection = collectionById.get(access.collection);
              const fieldById = new Map(collection?.fields.map((field) => [field.id, field.path]) ?? []);
              return (
                <div key={`${access.collection}-${access.operation}-${index}`} className="rounded-xl border border-white/8 bg-white/4 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    <span className="truncate">{collection?.label ?? access.collection}</span>
                    <span className="ml-auto shrink-0 rounded bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-200">{OPERATION[access.operation]}</span>
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    {access.fields?.length ? access.fields.map((field) => fieldById.get(field) ?? field).join(", ") : "ทุก field"}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      <nav className="pointer-events-auto absolute inset-x-4 bottom-4 z-20 mx-auto max-w-4xl rounded-2xl border border-white/10 bg-slate-950/78 p-3 shadow-2xl backdrop-blur-xl" aria-label="ทางออกจากขั้นตอนนี้">
        {current.doors.length ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="mr-1 text-[11px] text-slate-500">คลิก Step ใดก็ได้ หรือเลือกทางถัดไป:</span>
            {current.doors.map((door) => (
              <button key={door.transition.id} className="rounded-xl border border-white/12 bg-white/6 px-3 py-2 text-left text-xs transition hover:-translate-y-0.5 hover:border-cyan-400/35 hover:bg-cyan-400/10" disabled={transitioning} onClick={() => go(door.target.id)}>
                <span className="font-medium" style={{ color: KIND[door.target.kind].hex }}>{door.label}</span>
                <span className="ml-2 text-slate-500">→ {door.target.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3 text-sm">
            <span className="text-violet-200">✓ ถึงจุดสิ้นสุดแล้ว</span>
            <button className="mm-btn" onClick={() => {
              const entry = workflowEntry(workflow);
              if (entry) {
                setHistory([]);
                setRoute([]);
                setCurrentId(entry);
              }
            }}>เริ่มใหม่</button>
          </div>
        )}
      </nav>

    </main>
  );
}
