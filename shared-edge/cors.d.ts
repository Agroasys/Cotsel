import type { CorsOptions } from 'cors';

export interface SharedCorsOptions {
  allowedOrigins: string[];
  allowNoOrigin?: boolean;
  credentials?: boolean;
}

export function parseAllowedOrigins(raw: string | undefined): string[];
export function createCorsOptions(options: SharedCorsOptions): CorsOptions;
