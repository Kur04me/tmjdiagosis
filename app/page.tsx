'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnchorSelection,
  ModifierState,
  Side,
  VectorRegion,
  VectorShape,
} from '../components/VectorStage';

type WasmModule = typeof import('../wasm/pkg/tmj_core.js');

const VectorStage = dynamic(() => import('../components/VectorStage'), {
  ssr: false,
});

const MAX_POINTS = 10;
const DEFAULT_STAGE_SIZE = { width: 720, height: 540 };
const SIDES: Side[] = ['left', 'right'];
const SIDE_LABELS: Record<Side, string> = {
  left: '左顎関節',
  right: '右顎関節',
};
const SAMPLE_ENDPOINT: Record<Side, string> = {
  left: '/api/sample/left',
  right: '/api/sample/right',
};
const REGION_STYLES: Record<
  VectorRegion,
  { stroke: string; anchor: string }
> = {
  condyle: { stroke: '#63b3ed', anchor: '#3182ce' },
  fossa: { stroke: '#f6ad55', anchor: '#dd6b20' },
};
const STATUS_LABELS = {
  idle: '未処理',
  ready: '準備完了',
  processing: '処理中',
  done: '編集可',
  error: 'エラー',
} as const;

type SideState = {
  imageSrc: string | null;
  imageNode: HTMLImageElement | null;
  dimensions: { width: number; height: number } | null;
  vectorData: VectorShape | null;
  vectorJson: string | null;
  finalVectors: string | null;
  status: 'idle' | 'ready' | 'processing' | 'done' | 'error';
  statusMessage: string;
  selectedRegion: VectorRegion;
};

const createInitialSideState = (): SideState => ({
  imageSrc: null,
  imageNode: null,
  dimensions: null,
  vectorData: null,
  vectorJson: null,
  finalVectors: null,
  status: 'idle',
  statusMessage: '画像を読み込んでください。',
  selectedRegion: 'condyle',
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const distanceToSegmentSquared = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
) => {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) {
    return apx * apx + apy * apy;
  }
  const t = clamp((apx * abx + apy * aby) / abLenSq, 0, 1);
  const closestX = ax + abx * t;
  const closestY = ay + aby * t;
  const dx = px - closestX;
  const dy = py - closestY;
  return dx * dx + dy * dy;
};

const findInsertionIndex = (
  points: Array<[number, number]>,
  candidate: [number, number]
) => {
  if (points.length < 2) {
    return points.length;
  }

  let bestIndex = points.length;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < points.length - 1; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const distance = distanceToSegmentSquared(
      candidate[0],
      candidate[1],
      ax,
      ay,
      bx,
      by
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i + 1;
    }
  }

  const startDistance =
    (candidate[0] - points[0][0]) ** 2 + (candidate[1] - points[0][1]) ** 2;
  if (startDistance < bestDistance) {
    return 0;
  }
  const endDistance =
    (candidate[0] - points[points.length - 1][0]) ** 2 +
    (candidate[1] - points[points.length - 1][1]) ** 2;
  if (endDistance < bestDistance) {
    return points.length;
  }

  return bestIndex;
};

const resamplePoints = (
  points: Array<[number, number]>,
  maxPoints: number
) => {
  if (points.length <= maxPoints) {
    return points;
  }

  const result: Array<[number, number]> = [];
  const step = (points.length - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints; i += 1) {
    const t = step * i;
    const low = Math.floor(t);
    const high = Math.min(points.length - 1, Math.ceil(t));
    if (low === high) {
      result.push(points[low]);
    } else {
      const ratio = t - low;
      const [lx, ly] = points[low];
      const [hx, hy] = points[high];
      result.push([lx + (hx - lx) * ratio, ly + (hy - ly) * ratio]);
    }
  }

  return result;
};

const ensureMaxPoints = (
  vectorData: VectorShape,
  maxPoints: number
): VectorShape => ({
  condyle: resamplePoints(vectorData.condyle, maxPoints),
  fossa: resamplePoints(vectorData.fossa, maxPoints),
});

const buildVectorJson = (side: Side, vectorData: VectorShape) =>
  JSON.stringify(
    {
      side,
      condyle: vectorData.condyle,
      fossa: vectorData.fossa,
    },
    null,
    2
  );

export default function Home() {
  const [sideStates, setSideStates] = useState<Record<Side, SideState>>({
    left: createInitialSideState(),
    right: createInitialSideState(),
  });
  const [activeSelection, setActiveSelection] =
    useState<AnchorSelection | null>(null);
  const [modifierState, setModifierState] = useState<ModifierState>({
    space: false,
    ctrl: false,
    shift: false,
  });
  const [wasmMessage, setWasmMessage] = useState<string>(
    'Wasm module is not loaded yet.'
  );
  const wasmModuleRef = useRef<WasmModule | null>(null);

  const updateSideState = useCallback(
    (side: Side, updater: (previous: SideState) => SideState) => {
      setSideStates((previous) => {
        const next = { ...previous };
        next[side] = updater(previous[side]);
        return next;
      });
    },
    []
  );

  const loadWasm = useCallback(async () => {
    if (wasmModuleRef.current) {
      return wasmModuleRef.current;
    }

    const module = (await import('../wasm/pkg/tmj_core.js')) as WasmModule;
    if (typeof module.default === 'function') {
      await module.default();
    }
    wasmModuleRef.current = module;
    return module;
  }, []);

  const extractGrayscale = useCallback(
    (img: HTMLImageElement, width: number, height: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Canvas 2D context is not available.');
      }

      context.drawImage(img, 0, 0, width, height);
      const source = context.getImageData(0, 0, width, height).data;
      const grayscale = new Uint8Array(width * height);

      for (let i = 0, j = 0; i < source.length; i += 4, j += 1) {
        const r = source[i];
        const g = source[i + 1];
        const b = source[i + 2];
        grayscale[j] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }

      return grayscale;
    },
    []
  );

  const handleImageLoaded = useCallback(
    async (side: Side, dataUrl: string) => {
      const img = new Image();
      img.onload = async () => {
        setActiveSelection(null);
        updateSideState(side, (prev) => ({
          ...prev,
          imageSrc: dataUrl,
          imageNode: img,
          dimensions: {
            width: img.naturalWidth || DEFAULT_STAGE_SIZE.width,
            height: img.naturalHeight || DEFAULT_STAGE_SIZE.height,
          },
          vectorData: null,
          vectorJson: null,
          finalVectors: null,
          status: 'ready',
          statusMessage: '画像読み込み済み。自動抽出を実行してください。',
        }));

        try {
          const module = await loadWasm();
          const message = module.greet_wasm?.();
          setWasmMessage(message ?? 'Wasm module returned no message.');
        } catch (error) {
          console.error('Failed to initialize Wasm module.', error);
          setWasmMessage(
            'Wasm モジュールの初期化に失敗しました。`npm run wasm:build` を実行してください。'
          );
        }
      };
      img.onerror = () => {
        updateSideState(side, (prev) => ({
          ...prev,
          status: 'error',
          statusMessage: '画像の読み込みに失敗しました。',
        }));
      };
      img.src = dataUrl;
    },
    [loadWasm, updateSideState]
  );

  const handleFileChange = useCallback(
    (side: Side, event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : null;
        if (!result) {
          updateSideState(side, (prev) => ({
            ...prev,
            status: 'error',
            statusMessage: 'ファイルの読み込みに失敗しました。',
          }));
          return;
        }
        void handleImageLoaded(side, result);
      };
      reader.readAsDataURL(file);
    },
    [handleImageLoaded, updateSideState]
  );

  const handleLoadSample = useCallback(
    async (side: Side) => {
      try {
        updateSideState(side, (prev) => ({
          ...prev,
          statusMessage: 'サンプルを読み込んでいます...',
        }));
        const response = await fetch(SAMPLE_ENDPOINT[side]);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onload = () => {
          const result =
            typeof reader.result === 'string' ? reader.result : null;
          if (!result) {
            updateSideState(side, (prev) => ({
              ...prev,
              status: 'error',
              statusMessage: 'サンプルの読み込みに失敗しました。',
            }));
            return;
          }
          void handleImageLoaded(side, result);
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        console.error('Sample load failed', error);
        updateSideState(side, (prev) => ({
          ...prev,
          status: 'error',
          statusMessage:
            'サンプルの読み込みに失敗しました。ネットワーク環境を確認してください。',
        }));
      }
    },
    [handleImageLoaded, updateSideState]
  );

  const handleAutoExtract = useCallback(
    async (side: Side) => {
      const state = sideStates[side];
      if (!state.imageNode || !state.dimensions) {
        updateSideState(side, (prev) => ({
          ...prev,
          statusMessage: '先に画像を読み込んでください。',
        }));
        return;
      }

      updateSideState(side, (prev) => ({
        ...prev,
        status: 'processing',
        statusMessage: '自動抽出を実行しています...',
      }));
      setActiveSelection(null);

      try {
        const module = await loadWasm();
        const { width, height } = state.dimensions;
        const grayscale = extractGrayscale(state.imageNode, width, height);
        const raw = module.process_image_for_tmj(grayscale, width, height, side);
        const parsed = JSON.parse(raw) as {
          condyle?: Array<[number, number]>;
          fossa?: Array<[number, number]>;
        };
        const normalized: VectorShape = {
          condyle: parsed.condyle ?? [],
          fossa: parsed.fossa ?? [],
        };
        const constrained = ensureMaxPoints(normalized, MAX_POINTS);

        updateSideState(side, (prev) => ({
          ...prev,
          vectorData: constrained,
          vectorJson: buildVectorJson(side, constrained),
          finalVectors: null,
          status: 'done',
          statusMessage: '自動抽出完了。アンカーポイントを調整してください。',
        }));
      } catch (error) {
        console.error('Segmentation failed', error);
        updateSideState(side, (prev) => ({
          ...prev,
          status: 'error',
          statusMessage:
            'セグメンテーション処理に失敗しました。適切な画像かご確認ください。',
        }));
      }
    },
    [extractGrayscale, loadWasm, sideStates, updateSideState]
  );

  const handleAnchorDrag = useCallback(
    (side: Side, region: VectorRegion, index: number, x: number, y: number) => {
      let clampedX = x;
      let clampedY = y;
      updateSideState(side, (prev) => {
        if (!prev.vectorData) {
          return prev;
        }
        const limit = prev.dimensions ?? DEFAULT_STAGE_SIZE;
        clampedX = clamp(x, 0, limit.width);
        clampedY = clamp(y, 0, limit.height);
        const nextPoints = prev.vectorData[region].map((point, idx) =>
          idx === index ? ([clampedX, clampedY] as [number, number]) : point
        ) as Array<[number, number]>;
        const nextVector: VectorShape = {
          ...prev.vectorData,
          [region]: nextPoints,
        };
        return {
          ...prev,
          vectorData: nextVector,
          vectorJson: buildVectorJson(side, nextVector),
          finalVectors: null,
          statusMessage: 'アンカーポイントを調整しました。',
        };
      });
    },
    [updateSideState]
  );

  const handleAddAnchor = useCallback(
    (side: Side, point: { x: number; y: number }) => {
      const state = sideStates[side];
      const region = state.selectedRegion;
      const limit = state.dimensions ?? DEFAULT_STAGE_SIZE;
      const candidate: [number, number] = [
        clamp(point.x, 0, limit.width),
        clamp(point.y, 0, limit.height),
      ];

      let insertedIndex = -1;
      updateSideState(side, (prev) => {
        if (!prev.vectorData) {
          return prev;
        }
        const currentPoints = prev.vectorData[region];
        if (currentPoints.length >= MAX_POINTS) {
          return {
            ...prev,
            statusMessage: `アンカーポイントは最大 ${MAX_POINTS} 点です。`,
          };
        }

        const index = findInsertionIndex(currentPoints, candidate);
        insertedIndex = index;
        const nextPoints = [
          ...currentPoints.slice(0, index),
          candidate,
          ...currentPoints.slice(index),
        ] as Array<[number, number]>;
        const nextVector: VectorShape = {
          ...prev.vectorData,
          [region]: nextPoints,
        };

        return {
          ...prev,
          vectorData: nextVector,
          vectorJson: buildVectorJson(side, nextVector),
          finalVectors: null,
          statusMessage: 'アンカーポイントを追加しました。',
        };
      });

      if (insertedIndex >= 0) {
        setActiveSelection({ side, region, index: insertedIndex });
      }
    },
    [sideStates, updateSideState]
  );

  const handleRemoveSelectedAnchor = useCallback(() => {
    if (!activeSelection) {
      return;
    }

    const { side, region, index } = activeSelection;
    let nextSelection: AnchorSelection | null = null;

    updateSideState(side, (prev) => {
      if (!prev.vectorData) {
        return prev;
      }
      const currentPoints = prev.vectorData[region];
      if (currentPoints.length <= 3) {
        return {
          ...prev,
          statusMessage: 'アンカーポイントは3点以上必要です。',
        };
      }

      const nextPoints = currentPoints.filter((_, idx) => idx !== index);
      const nextVector: VectorShape = {
        ...prev.vectorData,
        [region]: nextPoints,
      };
      if (nextPoints.length > 0) {
        const nextIndex = Math.min(index, nextPoints.length - 1);
        nextSelection = { side, region, index: nextIndex };
      } else {
        nextSelection = null;
      }

      return {
        ...prev,
        vectorData: nextVector,
        vectorJson: buildVectorJson(side, nextVector),
        finalVectors: null,
        statusMessage: 'アンカーポイントを削除しました。',
      };
    });

    setActiveSelection(nextSelection);
  }, [activeSelection, updateSideState]);

  const handleConfirmVectors = useCallback(
    (side: Side) => {
      updateSideState(side, (prev) => {
        if (!prev.vectorData) {
          return {
            ...prev,
            statusMessage: 'アウトラインがまだ生成されていません。',
          };
        }
        const json = buildVectorJson(side, prev.vectorData);
        return {
          ...prev,
          finalVectors: json,
          statusMessage: 'アウトラインを確定しました。',
        };
      });
    },
    [updateSideState]
  );

  const combinedFinal = useMemo(() => {
    const payload: Partial<Record<Side, VectorShape>> = {};
    let hasAny = false;
    for (const side of SIDES) {
      const json = sideStates[side].finalVectors;
      if (!json) {
        continue;
      }
      try {
        const parsed = JSON.parse(json) as {
          condyle?: Array<[number, number]>;
          fossa?: Array<[number, number]>;
        };
        payload[side] = {
          condyle: parsed.condyle ?? [],
          fossa: parsed.fossa ?? [],
        };
        hasAny = true;
      } catch {
        // ignore parse errors
      }
    }
    return hasAny ? JSON.stringify(payload, null, 2) : '';
  }, [sideStates]);

  const operationHints = useMemo(
    () => [
      'パン: Space + 左ドラッグ（ドラッグ中はステージが移動します）',
      'ズーム: Ctrl (または ⌘) + ホイール',
      'アンカー移動: 左クリックでドラッグ',
      'アンカー追加: Shift + 左クリック（選択中の領域に追加）',
      'アンカー削除: Delete または Backspace（選択中のアンカー）',
    ],
    []
  );

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tagName = target.tagName.toLowerCase();
      return (
        target.isContentEditable ||
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select'
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === ' ' && !isTypingTarget(event.target)) {
        event.preventDefault();
      }

      switch (event.key) {
        case ' ':
          if (!isTypingTarget(event.target)) {
            setModifierState((prev) =>
              prev.space ? prev : { ...prev, space: true }
            );
          }
          break;
        case 'Control':
        case 'Meta':
          setModifierState((prev) =>
            prev.ctrl ? prev : { ...prev, ctrl: true }
          );
          break;
        case 'Shift':
          setModifierState((prev) =>
            prev.shift ? prev : { ...prev, shift: true }
          );
          break;
        case 'Delete':
        case 'Backspace':
          if (!isTypingTarget(event.target)) {
            event.preventDefault();
            void handleRemoveSelectedAnchor();
          }
          break;
        default:
          break;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      switch (event.key) {
        case ' ':
          setModifierState((prev) =>
            prev.space ? { ...prev, space: false } : prev
          );
          break;
        case 'Control':
        case 'Meta':
          setModifierState((prev) =>
            prev.ctrl ? { ...prev, ctrl: false } : prev
          );
          break;
        case 'Shift':
          setModifierState((prev) =>
            prev.shift ? { ...prev, shift: false } : prev
          );
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleRemoveSelectedAnchor]);

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        padding: '2rem',
        maxWidth: '1260px',
        margin: '0 auto',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h1 style={{ fontSize: '2rem', margin: 0 }}>TMJ Diagnosis</h1>
        <p style={{ margin: 0 }}>
          左右顎関節のアウトラインを Rust Wasm で自動抽出し、Konva 上で微調整します。
        </p>
      </header>

      <section
        style={{
          backgroundColor: '#1a202c',
          borderRadius: '0.75rem',
          padding: '1rem 1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Wasm status:</strong>
          <span>{wasmMessage}</span>
        </div>
        <div>
          <strong>操作ガイド</strong>
          <ul style={{ margin: '0.35rem 0 0 1.25rem', padding: 0, color: '#cbd5f5' }}>
            {operationHints.map((hint) => (
              <li key={hint} style={{ marginBottom: '0.25rem' }}>
                {hint}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        style={{
          display: 'grid',
          gap: '1.5rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))',
        }}
      >
        {SIDES.map((side) => {
          const state = sideStates[side];
          const isProcessing = state.status === 'processing';
          const canExtract = Boolean(state.imageNode && state.dimensions);
          const selection =
            activeSelection && activeSelection.side === side
              ? activeSelection
              : null;

          return (
            <article
              key={side}
              style={{
                backgroundColor: '#0c0c0c',
                borderRadius: '0.75rem',
                padding: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                }}
              >
                <h2 style={{ margin: 0, fontSize: '1.35rem' }}>
                  {SIDE_LABELS[side]}
                </h2>
                <span
                  style={{
                    fontSize: '0.85rem',
                    backgroundColor: '#2d3748',
                    color: '#e2e8f0',
                    padding: '0.25rem 0.75rem',
                    borderRadius: '999px',
                  }}
                >
                  {STATUS_LABELS[state.status]}: {state.statusMessage}
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  alignItems: 'center',
                }}
              >
                <label
                  style={{
                    display: 'inline-flex',
                    flexDirection: 'column',
                    gap: '0.3rem',
                    fontSize: '0.9rem',
                  }}
                >
                  <span>画像ファイルを選択</span>
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.bmp,.gif,.webp"
                    onChange={(event) => handleFileChange(side, event)}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => handleLoadSample(side)}
                  style={{
                    padding: '0.5rem 0.9rem',
                    borderRadius: '0.5rem',
                    border: '1px solid #2d3748',
                    backgroundColor: '#22543d',
                    color: '#e2e8f0',
                    cursor: 'pointer',
                  }}
                >
                  サンプル画像を読み込む
                </button>

                <button
                  type="button"
                  onClick={() => void handleAutoExtract(side)}
                  disabled={!canExtract || isProcessing}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '0.5rem',
                    border: 'none',
                    backgroundColor: canExtract
                      ? isProcessing
                        ? '#4a5568'
                        : '#2d3748'
                      : '#4a5568',
                    color: '#fff',
                    cursor: canExtract && !isProcessing ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isProcessing ? '処理中...' : '自動抽出'}
                </button>

                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    backgroundColor: '#1a202c',
                    border: '1px solid #2d3748',
                    borderRadius: '0.5rem',
                    padding: '0.35rem 0.6rem',
                  }}
                >
                  <span style={{ fontSize: '0.85rem' }}>編集対象:</span>
                  <select
                    value={state.selectedRegion}
                    onChange={(event) =>
                      updateSideState(side, (prev) => ({
                        ...prev,
                        selectedRegion: event.target.value as VectorRegion,
                        statusMessage: `${
                          event.target.value === 'condyle' ? '下顎頭' : '関節窩'
                        } を編集します。`,
                      }))
                    }
                    style={{
                      padding: '0.3rem 0.5rem',
                      borderRadius: '0.4rem',
                      border: '1px solid #2d3748',
                      backgroundColor: '#111827',
                      color: '#e2e8f0',
                    }}
                  >
                    <option value="condyle">下顎頭 (condyle)</option>
                    <option value="fossa">関節窩 (fossa)</option>
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => handleConfirmVectors(side)}
                  disabled={!state.vectorData}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '0.5rem',
                    border: '1px solid #2d3748',
                    backgroundColor: state.vectorData ? '#2b6cb0' : '#4a5568',
                    color: '#e2e8f0',
                    cursor: state.vectorData ? 'pointer' : 'not-allowed',
                  }}
                >
                  アウトラインを確定
                </button>
              </div>

              <div
                style={{
                  backgroundColor: '#111827',
                  borderRadius: '0.75rem',
                  padding: '0.75rem',
                  minHeight: '480px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {state.imageSrc && state.imageNode && state.dimensions ? (
                  <VectorStage
                    side={side}
                    image={state.imageNode}
                    dimensions={state.dimensions}
                    vectorData={state.vectorData}
                    selection={selection}
                    inputState={modifierState}
                    regionStyles={REGION_STYLES}
                    onSelectAnchor={(region, index) =>
                      setActiveSelection({ side, region, index })
                    }
                    onAnchorDrag={(region, index, x, y) =>
                      handleAnchorDrag(side, region, index, x, y)
                    }
                    onRequestAddAnchor={(point) => handleAddAnchor(side, point)}
                    onBackgroundClick={() => setActiveSelection(null)}
                  />
                ) : (
                  <p
                    style={{
                      color: '#718096',
                      textAlign: 'center',
                      lineHeight: 1.6,
                    }}
                  >
                    {SIDE_LABELS[side]}の画像を読み込み、自動抽出を行ってください。
                  </p>
                )}
              </div>

              <div
                style={{
                  display: 'grid',
                  gap: '1rem',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                }}
              >
                <div
                  style={{
                    backgroundColor: '#1a202c',
                    borderRadius: '0.75rem',
                    padding: '0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <strong>ベクター出力 (編集中)</strong>
                  <textarea
                    value={state.vectorJson ?? ''}
                    readOnly
                    placeholder="自動抽出後に JSON が表示されます。"
                    style={{
                      width: '100%',
                      minHeight: '180px',
                      borderRadius: '0.5rem',
                      border: '1px solid #2d3748',
                      backgroundColor: '#0f172a',
                      color: '#e2e8f0',
                      padding: '0.75rem',
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas',
                      fontSize: '0.85rem',
                    }}
                  />
                </div>

                <div
                  style={{
                    backgroundColor: '#1a202c',
                    borderRadius: '0.75rem',
                    padding: '0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <strong>確定したアウトライン</strong>
                  <textarea
                    value={state.finalVectors ?? ''}
                    readOnly
                    placeholder="「アウトラインを確定」後に表示されます。"
                    style={{
                      width: '100%',
                      minHeight: '180px',
                      borderRadius: '0.5rem',
                      border: '1px solid #2d3748',
                      backgroundColor: '#0f172a',
                      color: '#e2e8f0',
                      padding: '0.75rem',
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas',
                      fontSize: '0.85rem',
                    }}
                  />
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section
        style={{
          backgroundColor: '#1a202c',
          borderRadius: '0.75rem',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        <strong>左右まとめてエクスポート</strong>
        <textarea
          value={combinedFinal}
          readOnly
          placeholder="左右ともにアウトラインを確定すると JSON が表示されます。"
          style={{
            width: '100%',
            minHeight: '200px',
            borderRadius: '0.5rem',
            border: '1px solid #2d3748',
            backgroundColor: '#0f172a',
            color: '#e2e8f0',
            padding: '0.75rem',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas',
            fontSize: '0.85rem',
          }}
        />
      </section>
    </main>
  );
}
