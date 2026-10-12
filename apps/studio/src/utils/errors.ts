import { ApiError } from '../api/client';
import type { TKey } from '../i18n/strings';

/** Mapea un error de la API a claves i18n. */
export function apiErrorKey(e: unknown): TKey {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'NETWORK':
        return 'errors.network';
      case 'UNAUTHORIZED':
        return 'errors.unauthorized';
      case 'RUN_ACTIVE':
        return 'errors.runActive';
      case 'BUILD_ACTIVE':
        return 'errors.buildActive';
      case 'NOT_FOUND':
        return 'errors.notFound';
      default:
        return 'errors.generic';
    }
  }
  return 'errors.generic';
}

export function apiErrorHintKey(e: unknown): TKey | null {
  if (e instanceof ApiError && e.code === 'NETWORK') return 'errors.networkHint';
  if (e instanceof ApiError && e.detail) return null;
  return null;
}

/** Detalle técnico (mensaje del backend) para mostrar bajo el texto i18n. */
export function apiErrorDetail(e: unknown): string | null {
  if (e instanceof ApiError && e.detail && e.code !== 'NETWORK' && e.code !== 'UNAUTHORIZED') {
    return e.detail;
  }
  return null;
}
