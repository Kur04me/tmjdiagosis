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

type VectorRegion = 'condyle' | 'fossa';
type VectorShape = Record<VectorRegion, Array<[number, number]>>;

type VectorStageProps = {
  image: HTMLImageElement | null;
  dimensions: { width: number; height: number };
  vectorData: VectorShape | null;
  regionStyles: Record<VectorRegion, { stroke: string; fill: string }>;
  onAnchorDrag: (
    region: VectorRegion,
    index: number,
    x: number,
    y: number
  ) => void;
};

const clampScale = (value: number) => Math.min(Math.max(value, 0.5), 5);

export default function VectorStage({
  image,
  dimensions,
  vectorData,
  regionStyles,
  onAnchorDrag,
}: VectorStageProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const [stageScale, setStageScale] = useState<number>(1);
  const [stagePosition, setStagePosition] = useState<{ x: number; y: number }>(
    { x: 0, y: 0 }
  );

  useEffect(() => {
    setStageScale(1);
    setStagePosition({ x: 0, y: 0 });
  }, [dimensions.height, dimensions.width, image]);

  const linePoints = useCallback(
    (points: Array<[number, number]>) => points.flatMap(([x, y]) => [x, y]),
    []
  );

  const handleStageWheel = useCallback(
    (event: Konva.KonvaEventObject<WheelEvent>) => {
      event.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) {
        return;
      }

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
    [stagePosition.x, stagePosition.y, stageScale]
  );

  const handleStageDragEnd = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    setStagePosition(stage.position());
  }, []);

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
        draggable
        scaleX={stageScale}
        scaleY={stageScale}
        x={stagePosition.x}
        y={stagePosition.y}
        onWheel={handleStageWheel}
        onDragEnd={handleStageDragEnd}
        style={{ backgroundColor: '#111' }}
      >
        <Layer>
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
                  <Group key={region}>
                    <Line
                      points={linePoints(points)}
                      closed
                      stroke={style.stroke}
                      strokeWidth={3}
                      lineJoin="round"
                      lineCap="round"
                      fill={style.fill}
                    />
                    {points.map(([x, y], index) => (
                      <Circle
                        key={`${region}-anchor-${index}`}
                        x={x}
                        y={y}
                        radius={6}
                        fill={style.stroke}
                        stroke="#1a202c"
                        strokeWidth={2}
                        draggable
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
                        listening
                      />
                    ))}
                  </Group>
                );
              }
            )}
        </Layer>
      </Stage>
    </div>
  );
}
