import { BadRequestException } from '@nestjs/common';
import iconv from 'iconv-lite';
import Papa from 'papaparse';

type ParsedCsv = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

function decodeCsvBuffer(rawBuffer: Buffer): string {
  const attempts: Array<'utf8' | 'cp949' | 'euc-kr'> = ['utf8', 'cp949', 'euc-kr'];

  for (const encoding of attempts) {
    const decoded = iconv.decode(rawBuffer, encoding);
    if (!decoded.includes('\uFFFD')) {
      return decoded;
    }
  }

  return iconv.decode(rawBuffer, 'utf8');
}

export function parseCsvBuffer(rawBuffer: Buffer): ParsedCsv {
  const text = decodeCsvBuffer(rawBuffer);
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });

  const columns = (parsed.meta.fields ?? []).map((field) => field.trim()).filter(Boolean);
  if (columns.length === 0) {
    throw new BadRequestException('CSV header was not found.');
  }

  const rows = parsed.data
    .map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const column of columns) {
        normalized[column] = row[column] ?? '';
      }
      return normalized;
    })
    .filter((row) => Object.values(row).some((value) => String(value ?? '').trim() !== ''));

  if (rows.length === 0) {
    throw new BadRequestException('CSV contains no usable data rows.');
  }

  return { columns, rows };
}
