'use client';

import { useCallback, useMemo, useRef, useState } from "react";

type WasmModule = typeof import("../wasm/pkg/tmj_core.js");

type Point = {
  x: number;
  y: number;
};

const clampScale = (value: number) => Math.min(Math.max(value, 0.5), 5);

export default function Home() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [wasmMessage, setWasmMessage] = useState<string>(
    "Wasm module is not loaded yet."
  );
  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const dragStartRef = useRef<Point | null>(null);

  const placeholder = useMemo(
    () =>
      "画像ファイル（PNG / JPEG など）を選択するとモノクロ表示されます。操作: ドラッグで移動、ホイールでズーム。",
    []
  );

  const loadWasm = useCallback(async () => {
    try {
      const module = (await import("../wasm/pkg/tmj_core.js")) as WasmModule;
      const init = module.default;

      if (typeof init === "function") {
        await init();
      }

      if (typeof module.greet_wasm === "function") {
        return module.greet_wasm();
      }

      throw new Error("greet_wasm export is missing.");
    } catch (error) {
      console.error("Failed to initialize Wasm module.", error);
      throw error;
    }
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        const result = typeof reader.result === "string" ? reader.result : null;
        setImageSrc(result);
        setScale(1);
        setPosition({ x: 0, y: 0 });

        try {
          const message = await loadWasm();
          setWasmMessage(message ?? "Wasm module returned no message.");
        } catch {
          setWasmMessage(
            "Wasm モジュールの読み込みに失敗しました。`npm run wasm:build` を実行してください。"
          );
        }
      };
      reader.readAsDataURL(file);
    },
    [loadWasm]
  );

  const handlePointerDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!imageSrc) {
        return;
      }

      dragStartRef.current = {
        x: event.clientX - position.x,
        y: event.clientY - position.y,
      };
    },
    [imageSrc, position.x, position.y]
  );

  const handlePointerMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!imageSrc || !dragStartRef.current) {
        return;
      }

      setPosition({
        x: event.clientX - dragStartRef.current.x,
        y: event.clientY - dragStartRef.current.y,
      });
    },
    [imageSrc]
  );

  const handlePointerUp = useCallback(() => {
    dragStartRef.current = null;
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!imageSrc) {
      return;
    }

    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    setScale((previous) => clampScale(previous + delta));
  }, [imageSrc]);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        padding: "2rem",
        maxWidth: "960px",
        margin: "0 auto",
      }}
    >
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <h1 style={{ fontSize: "1.75rem", margin: 0 }}>TMJ Diagnosis</h1>
        <p style={{ margin: 0 }}>
          2Dモノクロ画像ビューア（Rust Wasm 連携テスト付き）
        </p>
        <label
          style={{
            display: "inline-flex",
            flexDirection: "column",
            gap: "0.5rem",
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
          backgroundColor: "#1e1e1e",
          padding: "1rem",
          borderRadius: "0.75rem",
          minHeight: "3rem",
          display: "flex",
          alignItems: "center",
        }}
      >
        <strong style={{ marginRight: "0.75rem" }}>Wasm status:</strong>
        <span>{wasmMessage}</span>
      </section>

      <section
        style={{
          position: "relative",
          backgroundColor: "#0c0c0c",
          borderRadius: "0.75rem",
          minHeight: "480px",
          overflow: "hidden",
        }}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseLeave={handlePointerUp}
        onMouseUp={handlePointerUp}
        onWheel={handleWheel}
      >
        {!imageSrc ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "2rem",
              color: "#888",
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            {placeholder}
          </div>
        ) : (
          <img
            src={imageSrc}
            alt="Uploaded 2D monochrome preview"
            draggable={false}
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${scale})`,
              transformOrigin: "center",
              filter: "grayscale(100%)",
              userSelect: "none",
              cursor: dragStartRef.current ? "grabbing" : "grab",
              maxWidth: "none",
            }}
          />
        )}
      </section>
    </main>
  );
}
