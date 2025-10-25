'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type WasmModule = typeof import('../wasm/pkg/tmj_core.js');
type VectorRegion = 'condyle' | 'fossa';

type VectorShape = Record<VectorRegion, Array<[number, number]>>;

const DEFAULT_STAGE_SIZE = { width: 720, height: 540 };

const VectorStage = dynamic(() => import('../components/VectorStage'), {
  ssr: false,
});

export default function Home() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageNode, setImageNode] = useState<HTMLImageElement | null>(null);
  const [imageDimensions, setImageDimensions] = useState<
    { width: number; height: number } | null
  >(null);
  const [wasmMessage, setWasmMessage] = useState<string>(
    'Wasm module is not loaded yet.'
  );
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [vectorData, setVectorData] = useState<VectorShape | null>(null);
  const [vectorJson, setVectorJson] = useState<string | null>(null);
  const [finalVectors, setFinalVectors] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] =
    useState<VectorRegion>('condyle');

  const wasmModuleRef = useRef<WasmModule | null>(null);

  const placeholder = useMemo(
    () =>
      '画像ファイル（PNG / JPEG など）を選択するとモノクロ表示されます。' +
      'ステージはドラッグでパン、ホイールでズームできます。',
    []
  );

  const loadWasm = useCallback(async () => {
    if (wasmModuleRef.current) {
      return wasmModuleRef.current;
    }

    try {
      const module = (await import(
        '../wasm/pkg/tmj_core.js'
      )) as WasmModule;
      if (typeof module.default === 'function') {
        await module.default();
      }
      wasmModuleRef.current = module;
      return module;
    } catch (error) {
      console.error('Failed to initialize Wasm module.', error);
      throw error;
    }
  }, []);

  const resetViewerState = useCallback(() => {
    setVectorData(null);
    setVectorJson(null);
    setFinalVectors(null);
    setErrorMessage(null);
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : null;
        if (!result) {
          setErrorMessage('ファイルの読み込みに失敗しました。');
          return;
        }

        const img = new Image();
        img.onload = async () => {
          setImageSrc(result);
          setImageNode(img);
          setImageDimensions({
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
          resetViewerState();

          try {
            const module = await loadWasm();
            const message = module.greet_wasm?.();
            setWasmMessage(message ?? 'Wasm module returned no message.');
          } catch {
            setWasmMessage(
              'Wasm モジュールの読み込みに失敗しました。`npm run wasm:build` を実行してください。'
            );
          }
        };
        img.onerror = () => {
          setErrorMessage('画像の読み込みに失敗しました。別のファイルを試してください。');
        };
        img.src = result;
      };
      reader.readAsDataURL(file);
    },
    [loadWasm, resetViewerState]
  );

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

  const handleAutoExtract = useCallback(async () => {
    if (!imageNode || !imageDimensions) {
      setErrorMessage('先に画像を読み込んでください。');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      const module = await loadWasm();
      const grayscale = extractGrayscale(
        imageNode,
        imageDimensions.width,
        imageDimensions.height
      );
      const result = module.process_image_for_tmj(
        grayscale,
        imageDimensions.width,
        imageDimensions.height
      );
      const parsed = JSON.parse(result) as Partial<VectorShape>;
      const normalized: VectorShape = {
        condyle: parsed.condyle ?? [],
        fossa: parsed.fossa ?? [],
      };

      setVectorData(normalized);
      setVectorJson(JSON.stringify(normalized, null, 2));
    } catch (error) {
      console.error('Segmentation failed', error);
      setErrorMessage(
        'セグメンテーション処理に失敗しました。画像がモノクロか確認してください。'
      );
    } finally {
      setIsProcessing(false);
    }
  }, [extractGrayscale, imageDimensions, imageNode, loadWasm]);

  const handleAnchorDrag = useCallback(
    (region: VectorRegion, index: number, x: number, y: number) => {
      setVectorData((previous) => {
        if (!previous) {
          return previous;
        }
        const limitX = imageDimensions?.width ?? DEFAULT_STAGE_SIZE.width;
        const limitY = imageDimensions?.height ?? DEFAULT_STAGE_SIZE.height;
        const clamped: [number, number] = [
          Math.min(Math.max(x, 0), limitX),
          Math.min(Math.max(y, 0), limitY),
        ];
        const nextRegion = previous[region].map((point, idx) =>
          idx === index ? clamped : point
        ) as Array<[number, number]>;
        return {
          ...previous,
          [region]: nextRegion,
        };
      });
    },
    [imageDimensions?.height, imageDimensions?.width]
  );

  const handleAddAnchor = useCallback(() => {
    setVectorData((previous) => {
      if (!previous) {
        return previous;
      }
      const points = previous[selectedRegion];
      const base = imageDimensions ?? DEFAULT_STAGE_SIZE;
      const newPoint: [number, number] =
        points.length >= 2
          ? [
              (points[0][0] + points[points.length - 1][0]) / 2,
              (points[0][1] + points[points.length - 1][1]) / 2,
            ]
          : [base.width / 2, base.height / 2];

      const insertIndex = Math.max(Math.floor(points.length / 2), 0);
      const nextPoints = [
        ...points.slice(0, insertIndex),
        newPoint,
        ...points.slice(insertIndex),
      ] as Array<[number, number]>;

      return {
        ...previous,
        [selectedRegion]: nextPoints,
      };
    });
  }, [imageDimensions, selectedRegion]);

  const handleRemoveAnchor = useCallback(() => {
    setVectorData((previous) => {
      if (!previous) {
        return previous;
      }
      const points = previous[selectedRegion];
      if (points.length <= 3) {
        setErrorMessage('アンカーポイントは3点以上必要です。');
        return previous;
      }

      const nextPoints = points.slice(0, points.length - 1);
      return {
        ...previous,
        [selectedRegion]: nextPoints as Array<[number, number]>,
      };
    });
  }, [selectedRegion]);

  const handleConfirmVectors = useCallback(() => {
    if (!vectorData) {
      setErrorMessage('ベクターパスが生成されていません。');
      return;
    }

    const snapshot = JSON.stringify(vectorData, null, 2);
    setFinalVectors(snapshot);
    setErrorMessage(null);
  }, [vectorData]);

  useEffect(() => {
    if (vectorData) {
      setFinalVectors(null);
    }
  }, [vectorData]);

  const stageDimensions = imageDimensions ?? DEFAULT_STAGE_SIZE;

  const stageVisible = Boolean(imageSrc && imageNode);
  const regionStyles: Record<VectorRegion, { stroke: string; fill: string }> = {
    condyle: { stroke: '#38b2ac', fill: 'rgba(56, 178, 172, 0.18)' },
    fossa: { stroke: '#f6ad55', fill: 'rgba(246, 173, 85, 0.18)' },
  };

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        padding: '2rem',
        maxWidth: '1100px',
        margin: '0 auto',
      }}
    >
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        <h1 style={{ fontSize: '1.75rem', margin: 0 }}>TMJ Diagnosis</h1>
        <p style={{ margin: 0 }}>
          2Dモノクロ画像ビューア（Rust Wasm 連携 &amp; ベクター編集）
        </p>
        <label
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <span>2D画像ファイルを選択</span>
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.bmp,.gif,.webp"
            onChange={handleFileChange}
          />
        </label>
      </section>

      <section
        style={{
          backgroundColor: '#1e1e1e',
          padding: '1rem',
          borderRadius: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Wasm status:</strong>
          <span>{wasmMessage}</span>
        </div>
        {errorMessage && (
          <div style={{ color: '#f56565' }}>{errorMessage}</div>
        )}
      </section>

      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleAutoExtract}
            disabled={!imageSrc || isProcessing}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: 'none',
              backgroundColor: isProcessing ? '#4a5568' : '#2d3748',
              color: '#fff',
              cursor: !imageSrc || isProcessing ? 'not-allowed' : 'pointer',
            }}
          >
            {isProcessing ? '処理中...' : '自動抽出を実行'}
          </button>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>編集対象:</span>
            <select
              value={selectedRegion}
              onChange={(event) =>
                setSelectedRegion(event.target.value as VectorRegion)
              }
              style={{
                padding: '0.4rem 0.6rem',
                borderRadius: '0.5rem',
                border: '1px solid #2d3748',
                backgroundColor: '#1a202c',
                color: '#e2e8f0',
              }}
            >
              <option value="condyle">下顎頭 (condyle)</option>
              <option value="fossa">関節窩 (fossa)</option>
            </select>
          </label>

          <button
            type="button"
            onClick={handleAddAnchor}
            disabled={!vectorData}
            style={{
              padding: '0.5rem 0.9rem',
              borderRadius: '0.5rem',
              border: '1px solid #2d3748',
              backgroundColor: '#22543d',
              color: '#e2e8f0',
              cursor: vectorData ? 'pointer' : 'not-allowed',
            }}
          >
            アンカーポイント追加
          </button>

          <button
            type="button"
            onClick={handleRemoveAnchor}
            disabled={!vectorData}
            style={{
              padding: '0.5rem 0.9rem',
              borderRadius: '0.5rem',
              border: '1px solid #2d3748',
              backgroundColor: '#742a2a',
              color: '#e2e8f0',
              cursor: vectorData ? 'pointer' : 'not-allowed',
            }}
          >
            アンカーポイント削除
          </button>

          <button
            type="button"
            onClick={handleConfirmVectors}
            disabled={!vectorData}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: '1px solid #2d3748',
              backgroundColor: '#2b6cb0',
              color: '#e2e8f0',
              cursor: vectorData ? 'pointer' : 'not-allowed',
            }}
          >
            アウトラインを確定
          </button>
        </div>

        <p style={{ margin: 0, color: '#a0aec0' }}>
          ステージ上のパスはドラッグで移動できます。アンカーポイントはドラッグで位置調整可能です。
          編集後は「アウトラインを確定」を押して最終座標を記録してください。
        </p>
      </section>

      <section
        style={{
          backgroundColor: '#0c0c0c',
          borderRadius: '0.75rem',
          padding: '1rem',
          minHeight: '520px',
        }}
      >
        {!stageVisible ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              padding: '2rem',
              color: '#718096',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            {placeholder}
          </div>
        ) : (
          <VectorStage
            image={imageNode}
            dimensions={stageDimensions}
            vectorData={vectorData}
            regionStyles={regionStyles}
            onAnchorDrag={handleAnchorDrag}
          />
        )}
      </section>

      <section
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        }}
      >
        <div
          style={{
            backgroundColor: '#1a202c',
            padding: '1rem',
            borderRadius: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <strong>Rust Wasm からのベクター出力</strong>
          <textarea
            value={vectorJson ?? ''}
            readOnly
            placeholder="自動抽出を実行するとJSONが表示されます。"
            style={{
              width: '100%',
              minHeight: '220px',
              borderRadius: '0.5rem',
              border: '1px solid #2d3748',
              backgroundColor: '#0f172a',
              color: '#e2e8f0',
              padding: '0.75rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas',
              fontSize: '0.85rem',
            }}
          />
        </div>

        <div
          style={{
            backgroundColor: '#1a202c',
            padding: '1rem',
            borderRadius: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <strong>確定したアウトライン座標</strong>
          <textarea
            value={finalVectors ?? ''}
            readOnly
            placeholder="「アウトラインを確定」を押すと反映されます。"
            style={{
              width: '100%',
              minHeight: '220px',
              borderRadius: '0.5rem',
              border: '1px solid #2d3748',
              backgroundColor: '#0f172a',
              color: '#e2e8f0',
              padding: '0.75rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas',
              fontSize: '0.85rem',
            }}
          />
        </div>
      </section>
    </main>
  );
}
