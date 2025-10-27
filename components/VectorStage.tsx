'use client';

import Konva from 'konva';
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
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

type VectorStageProps = {
  side: Side;
  image: HTMLImageElement | null;
  dimensions: { width: number; height: number } | null;
  vectorData: VectorShape | null;
  selection: AnchorSelection | null;
  inputState: ModifierState;
  regionStyles: Record<VectorRegion, RegionStyle>;
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
  onBackgroundClick: () => void;
};

const clampScale = (value: number) => Math.min(Math.max(value, 0.5), 5);

export default function VectorStage({
  side,
  image,
  dimensions,
  vectorData,
  selection,
  inputState,
  regionStyles,
  onSelectAnchor,
  onAnchorDrag,
  onRequestAddAnchor,
  onBackgroundClick,
}: VectorStageProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const [stageScale, setStageScale] = useState<number>(1);
  const [stagePosition, setStagePosition] = useState<{ x: number; y: number }>(
    { x: 0, y: 0 }
  );

  useEffect(() => {
    setStageScale(1);
    setStagePosition({ x: 0, y: 0 });
  }, [dimensions?.height, dimensions?.width, image, side]);

  useEffect(() => {
    const container = stageRef.current?.container();
    if (!container) {
      return;
    }
    container.style.cursor = inputState.space ? 'grab' : 'default';
  }, [inputState.space]);

  const updateCursor = useCallback((cursor: string) => {
    const container = stageRef.current?.container();
    if (container) {
      container.style.cursor = cursor;
    }
  }, []);

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
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    setStagePosition(stage.position());
    updateCursor(inputState.space ? 'grab' : 'default');
  }, [inputState.space, updateCursor]);

  const handleStageDragStart = useCallback(() => {
    updateCursor('grabbing');
  }, [updateCursor]);

  const handleStageClick = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent>) => {
      const stage = stageRef.current;
      if (!stage) {
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
        draggable={inputState.space}
        scaleX={stageScale}
        scaleY={stageScale}
        x={stagePosition.x}
        y={stagePosition.y}
        onWheel={handleStageWheel}
        onDragEnd={handleStageDragEnd}
        onDragStart={handleStageDragStart}
        onClick={handleStageClick}
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
                          draggable={!inputState.space}
                          onMouseDown={(event) => {
                            event.cancelBubble = true;
                            onSelectAnchor(region, index);
                          }}
                          onDragMove={(event) =>
                            onAnchorDrag(
                              region,
                              index,
                              event.target.x(),
                              event.target.y()
                            )
                          }
                          onDragEnd={(event) =>
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
