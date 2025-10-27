'use client';

import Konva from 'konva';
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Text,
  Stage,
} from 'react-konva';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Side = 'left' | 'right';
export type VectorRegion = 'condyle' | 'fossa';
export type VectorShape = Record<VectorRegion, Array<[number, number]>>;
export type AnchorSelection = {
  side: Side;
  region: VectorRegion;
  index: number;
};
export type ModifierState = {
  space: boolean;
  ctrl: boolean;
  shift: boolean;
};

type RegionStyle = {
  stroke: string;
  anchor: string;
  label: string;
};

type CalibrationOverlay = {
  active: boolean;
  points: Array<[number, number]>;
};

type FitViewRequest = {
  scale: number;
  position: { x: number; y: number };
  token: number;
};

type VectorStageProps = {
  side: Side;
  image: HTMLImageElement | null;
  dimensions: { width: number; height: number } | null;
  vectorData: VectorShape | null;
  selection: AnchorSelection | null;
  inputState: ModifierState;
  regionStyles: Record<VectorRegion, RegionStyle>;
  calibration: CalibrationOverlay;
  fitViewRequest?: FitViewRequest | null;
  onSelectAnchor: (region: VectorRegion, index: number) => void;
  onAnchorDrag: (
    region: VectorRegion,
    index: number,
    x: number,
    y: number
  ) => void;
  onRequestAddAnchor: (
    region: VectorRegion,
    point: { x: number; y: number }
  ) => void;
  onCalibrationPoint: (point: { x: number; y: number }) => void;
  onBackgroundClick: () => void;
};

const clampScale = (value: number) => Math.min(Math.max(value, 0.5), 5);
const clampValue = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export default function VectorStage({
  side,
  image,
  dimensions,
  vectorData,
  selection,
  inputState,
  regionStyles,
  calibration,
  fitViewRequest,
  onSelectAnchor,
  onAnchorDrag,
  onRequestAddAnchor,
  onCalibrationPoint,
  onBackgroundClick,
}: VectorStageProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const [stageScale, setStageScale] = useState<number>(1);
  const [stagePosition, setStagePosition] = useState<{ x: number; y: number }>(
    { x: 0, y: 0 }
  );
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setStageScale(1);
    setStagePosition({ x: 0, y: 0 });
  }, [dimensions?.height, dimensions?.width, image, side]);

  useEffect(() => {
    const container = stageRef.current?.container();
    if (!container) {
      return;
    }
    if (calibration.active) {
      container.style.cursor = 'crosshair';
      return;
    }
    container.style.cursor = inputState.space ? 'grab' : 'default';
  }, [calibration.active, inputState.space]);

  const updateCursor = useCallback((cursor: string) => {
    const container = stageRef.current?.container();
    if (container) {
      container.style.cursor = cursor;
    }
  }, []);

  useEffect(() => {
    if (!calibration.active) {
      setPointer(null);
    }
  }, [calibration.active]);

  useEffect(() => {
    if (!fitViewRequest) {
      return;
    }
    const stage = stageRef.current;
    setStageScale(fitViewRequest.scale);
    setStagePosition(fitViewRequest.position);
    if (stage) {
      stage.to({
        duration: 0.45,
        easing: Konva.Easings.EaseInOut,
        scaleX: fitViewRequest.scale,
        scaleY: fitViewRequest.scale,
        x: fitViewRequest.position.x,
        y: fitViewRequest.position.y,
      });
    }
  }, [fitViewRequest?.token]);

  const distanceToSegmentSquared = useCallback(
    (
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
      const t = Math.min(Math.max((apx * abx + apy * aby) / abLenSq, 0), 1);
      const closestX = ax + abx * t;
      const closestY = ay + aby * t;
      const dx = px - closestX;
      const dy = py - closestY;
      return dx * dx + dy * dy;
    },
    []
  );

  const measureRegionDistance = useCallback(
    (region: VectorRegion, point: { x: number; y: number }) => {
      const points = vectorData?.[region] ?? [];
      if (!points.length) {
        return Number.POSITIVE_INFINITY;
      }

      let best = Number.POSITIVE_INFINITY;

      for (let i = 0; i < points.length - 1; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        const distance = distanceToSegmentSquared(
          point.x,
          point.y,
          ax,
          ay,
          bx,
          by
        );
        if (distance < best) {
          best = distance;
        }
      }

      const start = points[0];
      const end = points[points.length - 1];
      const startDistance =
        (point.x - start[0]) ** 2 + (point.y - start[1]) ** 2;
      const endDistance = (point.x - end[0]) ** 2 + (point.y - end[1]) ** 2;
      return Math.min(best, startDistance, endDistance);
    },
    [distanceToSegmentSquared, vectorData]
  );

  const determineRegionForPoint = useCallback(
    (point: { x: number; y: number }): VectorRegion => {
      const regions: VectorRegion[] = ['condyle', 'fossa'];
      let bestRegion: VectorRegion = 'condyle';
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const region of regions) {
        const distance = measureRegionDistance(region, point);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestRegion = region;
        }
      }

      return bestRegion;
    },
    [measureRegionDistance]
  );

  const linePoints = useCallback(
    (points: Array<[number, number]>) => points.flatMap(([x, y]) => [x, y]),
    []
  );

  const handleStageWheel = useCallback(
    (event: Konva.KonvaEventObject<WheelEvent>) => {
      if (calibration.active) {
        return;
      }
      const stage = stageRef.current;
      if (!stage) {
        return;
      }

      if (!inputState.ctrl) {
        return;
      }

      event.evt.preventDefault();

      const scaleBy = 1.05;
      const oldScale = stageScale;
      const pointer = stage.getPointerPosition();
      if (!pointer) {
        return;
      }

      const mousePointTo = {
        x: (pointer.x - stagePosition.x) / oldScale,
        y: (pointer.y - stagePosition.y) / oldScale,
      };

      const direction = event.evt.deltaY > 0 ? 1 : -1;
      const newScale =
        direction > 0
          ? clampScale(oldScale / scaleBy)
          : clampScale(oldScale * scaleBy);

      const newPosition = {
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      };

      setStageScale(newScale);
      setStagePosition(newPosition);
    },
    [inputState.ctrl, stagePosition.x, stagePosition.y, stageScale]
  );

  const handleStageDragEnd = useCallback(() => {
    if (calibration.active) {
      return;
    }
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    setStagePosition(stage.position());
    updateCursor(inputState.space ? 'grab' : 'default');
  }, [inputState.space, updateCursor]);

  const handleStageDragStart = useCallback(() => {
    if (calibration.active || !inputState.space) {
      const stage = stageRef.current;
      if (stage) {
        stage.stopDrag();
      }
      return;
    }
    updateCursor('grabbing');
  }, [calibration.active, inputState.space, updateCursor]);

  const handleStageClick = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent>) => {
      const stage = stageRef.current;
      if (!stage) {
        return;
      }

      if (calibration.active) {
        const pointer = stage.getRelativePointerPosition();
        if (pointer) {
          onCalibrationPoint({ x: pointer.x, y: pointer.y });
        }
        return;
      }

      if (inputState.shift && vectorData) {
        const pointer = stage.getRelativePointerPosition();
        if (!pointer) {
          return;
        }
        const region = determineRegionForPoint({
          x: pointer.x,
          y: pointer.y,
        });
        onRequestAddAnchor(region, { x: pointer.x, y: pointer.y });
        return;
      }

      if (event.target === stage || event.target === stage.findOne('Image')) {
        onBackgroundClick();
      }
    },
    [inputState.shift, onBackgroundClick, onRequestAddAnchor, vectorData]
  );

  if (!dimensions) {
    return null;
  }

  return (
    <div
      className="vector-stage-container"
      style={{
        position: 'relative',
        overflow: 'auto',
        borderRadius: '0.5rem',
        border: '1px solid #2d3748',
        backgroundColor: '#1a202c',
        maxHeight: '720px',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: '0.75rem auto auto 0.75rem',
          display: 'flex',
          gap: '0.75rem',
          padding: '0.35rem 0.6rem',
          borderRadius: '0.5rem',
          backgroundColor: 'rgba(17, 24, 39, 0.7)',
          color: '#e2e8f0',
          fontSize: '0.75rem',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      >
        {(['condyle', 'fossa'] as VectorRegion[]).map((region) => {
          const style = regionStyles[region];
          return (
            <span
              key={`${side}-${region}-legend`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: '0.75rem',
                  height: '0.75rem',
                  borderRadius: '999px',
                  backgroundColor: style.stroke,
                  boxShadow: '0 0 0 1px rgba(15, 23, 42, 0.6)',
                }}
              />
              {style.label}
            </span>
          );
        })}
      </div>
      <Stage
        ref={stageRef}
        width={dimensions.width}
        height={dimensions.height}
        draggable
        scaleX={stageScale}
        scaleY={stageScale}
        x={stagePosition.x}
        y={stagePosition.y}
        dragBoundFunc={(pos) => {
          if (!inputState.space || calibration.active) {
            const stage = stageRef.current;
            return stage ? stage.position() : stagePosition;
          }
          return pos;
        }}
        onWheel={handleStageWheel}
        onDragEnd={handleStageDragEnd}
        onDragStart={handleStageDragStart}
        onClick={handleStageClick}
        onMouseMove={() => {
          if (!calibration.active) {
            return;
          }
          const stage = stageRef.current;
          if (!stage || !dimensions) {
            return;
          }
          const pos = stage.getRelativePointerPosition();
          if (!pos) {
            return;
          }
          setPointer({
            x: clampValue(pos.x, 0, dimensions.width),
            y: clampValue(pos.y, 0, dimensions.height),
          });
        }}
        onMouseLeave={() => {
          if (calibration.active) {
            setPointer(null);
          }
        }}
        style={{ backgroundColor: '#111' }}
      >
        <Layer listening>
          {image && (
            <KonvaImage
              image={image}
              x={0}
              y={0}
              width={dimensions.width}
              height={dimensions.height}
              opacity={0.9}
            />
          )}

          {calibration.points.length > 0 && (
            <Group listening={false}>
              <Circle
                x={calibration.points[0][0]}
                y={calibration.points[0][1]}
                radius={6}
                fill="#fbd38d"
                stroke="#1a202c"
                strokeWidth={2}
              />
              {calibration.points.length === 2 && (
                <>
                  <Circle
                    x={calibration.points[1][0]}
                    y={calibration.points[1][1]}
                    radius={6}
                    fill="#fbd38d"
                    stroke="#1a202c"
                    strokeWidth={2}
                  />
                  <Line
                    points={[
                      calibration.points[0][0],
                      calibration.points[0][1],
                      calibration.points[1][0],
                      calibration.points[1][1],
                    ]}
                    stroke="#fbd38d"
                    strokeWidth={3}
                    lineCap="round"
                    dash={[10, 6]}
                  />
                </>
              )}
            </Group>
          )}

          {calibration.active && pointer && image && (
            <Group listening={false} x={12} y={12}>
              {(() => {
                const magnifierSize = 120;
                const padding = 10;
                const cropSize = Math.min(
                  60,
                  Math.max(20, Math.min(dimensions.width, dimensions.height) / 4)
                );
                const effectiveCrop = cropSize / stageScale;
                const cropX = clampValue(
                  pointer.x - effectiveCrop / 2,
                  0,
                  Math.max(0, dimensions.width - effectiveCrop)
                );
                const cropY = clampValue(
                  pointer.y - effectiveCrop / 2,
                  0,
                  Math.max(0, dimensions.height - effectiveCrop)
                );
                const scaleFactor = magnifierSize / effectiveCrop;
                const crosshairX = clampValue(
                  (pointer.x - cropX) * scaleFactor,
                  0,
                  magnifierSize
                );
                const crosshairY = clampValue(
                  (pointer.y - cropY) * scaleFactor,
                  0,
                  magnifierSize
                );

                return (
                  <>
                    <Rect
                      width={magnifierSize + padding * 2}
                      height={magnifierSize + padding * 2 + 20}
                      cornerRadius={8}
                      fill="rgba(17, 24, 39, 0.9)"
                      stroke="#fbd38d"
                      strokeWidth={1}
                    />
                    <Group
                      x={padding}
                      y={padding}
                      clip={{
                        x: 0,
                        y: 0,
                        width: magnifierSize,
                        height: magnifierSize,
                      }}
                    >
                      <Rect width={magnifierSize} height={magnifierSize} fill="#0f172a" />
                      <KonvaImage
                        image={image}
                        width={magnifierSize}
                        height={magnifierSize}
                        crop={{
                          x: cropX,
                          y: cropY,
                          width: effectiveCrop,
                          height: effectiveCrop,
                        }}
                      />
                      <Line
                        points={[crosshairX, 0, crosshairX, magnifierSize]}
                        stroke="#fbd38d"
                        strokeWidth={1}
                        dash={[4, 4]}
                      />
                      <Line
                        points={[0, crosshairY, magnifierSize, crosshairY]}
                        stroke="#fbd38d"
                        strokeWidth={1}
                        dash={[4, 4]}
                      />
                    </Group>
                    <Rect
                      x={padding}
                      y={padding}
                      width={magnifierSize}
                      height={magnifierSize}
                      stroke="#fbd38d"
                      strokeWidth={1}
                      cornerRadius={4}
                    />
                    <Text
                      text="拡大表示"
                      x={padding}
                      y={padding + magnifierSize + 6}
                      fontSize={12}
                      fill="#fbd38d"
                    />
                  </>
                );
              })()}
            </Group>
          )}

          {vectorData &&
            (Object.keys(vectorData) as Array<VectorRegion>).map(
              (region) => {
                const points = vectorData[region];
                if (!points.length) {
                  return null;
                }
                const style = regionStyles[region];
                return (
                  <Group key={`${side}-${region}`}>
                    <Line
                      points={linePoints(points)}
                      closed={false}
                      stroke={style.stroke}
                      strokeWidth={3}
                      lineJoin="round"
                      lineCap="round"
                      hitStrokeWidth={12}
                    />
                    {points.map(([x, y], index) => {
                      const isSelected =
                        selection?.region === region &&
                        selection.index === index &&
                        selection.side === side;
                      return (
                        <Circle
                          key={`${region}-anchor-${index}`}
                          x={x}
                          y={y}
                          radius={isSelected ? 8 : 6}
                          fill={style.anchor}
                          stroke={isSelected ? '#fbd38d' : '#1a202c'}
                          strokeWidth={isSelected ? 3 : 2}
                          draggable={!inputState.space && !calibration.active}
                          onMouseDown={(event) => {
                            if (calibration.active) {
                              return;
                            }
                            event.cancelBubble = true;
                          onSelectAnchor(region, index);
                        }}
                        onDragMove={(event) =>
                          calibration.active
                            ? undefined
                            :
                          onAnchorDrag(
                            region,
                            index,
                            event.target.x(),
                            event.target.y()
                          )
                        }
                        onDragEnd={(event) =>
                          calibration.active
                            ? undefined
                            :
                          onAnchorDrag(
                            region,
                            index,
                            event.target.x(),
                            event.target.y()
                            )
                          }
                        />
                      );
                    })}
                  </Group>
                );
              }
            )}
        </Layer>
      </Stage>
    </div>
  );
}
