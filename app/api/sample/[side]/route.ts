import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const SIDE_TO_FILENAME: Record<string, string> = {
  left: 'left_condyle.jpg',
  right: 'right_contyle.jpg',
};

type RouteParams = { side?: string | string[] } | Promise<{ side?: string | string[] }>;

export async function GET(request: Request, context: { params: RouteParams }) {
  const params = await context.params;
  const rawSide = Array.isArray(params.side) ? params.side[0] : params.side;
  const sideParam = rawSide?.toLowerCase();
  if (!sideParam) {
    return new NextResponse('Missing side parameter', { status: 400 });
  }

  const fileName = SIDE_TO_FILENAME[sideParam];
  if (!fileName) {
    return new NextResponse('Invalid side parameter', { status: 400 });
  }

  try {
    const filePath = path.join(
      process.cwd(),
      'sample',
      fileName
    );
    const file = await fs.readFile(filePath);
    return new NextResponse(file, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Failed to load sample image', error);
    return new NextResponse('Sample not found', { status: 404 });
  }
}
