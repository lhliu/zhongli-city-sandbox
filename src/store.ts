import { create } from 'zustand';
import type { SceneDTO } from './lib/model/types';
import { fetchScene, errorText } from './api';

export type CameraMode = 'top' | 'orbit' | 'walk';
export type Selection =
  | { type: 'parcel'; ids: string[] }
  | { type: 'development'; id: string }
  | { type: 'building'; id: string }
  | null;

export type LayerKey = 'basemap' | 'boundary' | 'parcels' | 'parks' | 'buildings' | 'labels';
export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'conflict'; message: string } | { kind: 'error'; message: string };

export type DrawTarget = { type: 'new' } | { type: 'parcel'; id: string; expectedVersion: number };
export type DrawState = { active: boolean; points: [number, number][]; target: DrawTarget };

type State = {
  draw: DrawState;
  startDraw: (target: DrawTarget) => void;
  addDrawPoint: (p: [number, number]) => void;
  undoDrawPoint: () => void;
  endDraw: () => void;
  projectId: string | null;
  scene: SceneDTO | null;
  loading: boolean;
  loadError: string | null;
  scenarioId: string | null;
  selection: Selection;
  cameraMode: CameraMode;
  eyeHeightM: number;
  layers: Record<LayerKey, { visible: boolean; opacity: number }>;
  save: SaveState;
  videoMode: boolean;
  /** 遞增時要求相機回到全區 */
  resetCameraTick: number;
  /** 套用書籤 */
  pendingCamera: { mode: CameraMode; camera: import('./lib/model/schemas').CameraState } | null;
  load: (projectId: string, scenarioId?: string | null) => Promise<void>;
  reload: () => Promise<void>;
  setScenario: (id: string) => Promise<void>;
  select: (s: Selection) => void;
  toggleParcel: (id: string, additive: boolean) => void;
  setCameraMode: (m: CameraMode) => void;
  setEyeHeight: (h: number) => void;
  setLayer: (k: LayerKey, v: Partial<{ visible: boolean; opacity: number }>) => void;
  setSave: (s: SaveState) => void;
  setVideoMode: (v: boolean) => void;
  resetCamera: () => void;
  applyBookmark: (p: State['pendingCamera']) => void;
};

export const useStore = create<State>((set, get) => ({
  draw: { active: false, points: [], target: { type: 'new' } },
  startDraw: (target) => set({ draw: { active: true, points: [], target }, cameraMode: 'top', selection: null }),
  addDrawPoint: (p) => set({ draw: { ...get().draw, points: [...get().draw.points, p] } }),
  undoDrawPoint: () => set({ draw: { ...get().draw, points: get().draw.points.slice(0, -1) } }),
  endDraw: () => set({ draw: { active: false, points: [], target: { type: 'new' } } }),
  projectId: null,
  scene: null,
  loading: false,
  loadError: null,
  scenarioId: null,
  selection: null,
  cameraMode: 'orbit',
  eyeHeightM: 1.6,
  layers: {
    basemap: { visible: true, opacity: 1 },
    boundary: { visible: true, opacity: 1 },
    parcels: { visible: true, opacity: 0.55 },
    parks: { visible: true, opacity: 0.8 },
    buildings: { visible: true, opacity: 1 },
    labels: { visible: true, opacity: 1 },
  },
  save: { kind: 'idle' },
  videoMode: false,
  resetCameraTick: 0,
  pendingCamera: null,
  async load(projectId, scenarioId) {
    set({ loading: true, loadError: null, projectId });
    try {
      const scene = await fetchScene(projectId, scenarioId ?? get().scenarioId);
      set({ scene, scenarioId: scene.scenario.id, loading: false });
    } catch (e) {
      set({ loading: false, loadError: errorText(e) });
    }
  },
  async reload() {
    const { projectId, scenarioId } = get();
    if (!projectId) return;
    const scene = await fetchScene(projectId, scenarioId);
    // 選取的棟別若在新情境不存在則取消選取
    const sel = get().selection;
    const keep = !sel || sel.type !== 'building' || scene.buildings.some((b) => b.id === sel.id);
    set({ scene, selection: keep ? sel : null });
  },
  async setScenario(id) {
    set({ scenarioId: id });
    await get().reload();
  },
  select: (selection) => set({ selection }),
  toggleParcel(id, additive) {
    const sel = get().selection;
    if (additive && sel?.type === 'parcel') {
      const ids = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id];
      set({ selection: ids.length ? { type: 'parcel', ids } : null });
    } else set({ selection: { type: 'parcel', ids: [id] } });
  },
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setEyeHeight: (eyeHeightM) => set({ eyeHeightM }),
  setLayer: (k, v) => set({ layers: { ...get().layers, [k]: { ...get().layers[k], ...v } } }),
  setSave: (save) => set({ save }),
  setVideoMode: (videoMode) => set({ videoMode }),
  resetCamera: () => set({ resetCameraTick: get().resetCameraTick + 1 }),
  applyBookmark: (pendingCamera) => set({ pendingCamera, cameraMode: pendingCamera?.mode ?? get().cameraMode }),
}));
