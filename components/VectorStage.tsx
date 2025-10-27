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
  onRequestAddAnchor: (point: { x: number; y: number }) => void;
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
        onRequestAddAnchor({ x: pointer.x, y: pointer.y });
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
        overflow: 'auto',
        borderRadius: '0.5rem',
        border: '1px solid #2d3748',
        backgroundColor: '#1a202c',
        maxHeight: '720px',
      }}
    >
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
