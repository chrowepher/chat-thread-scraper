const NON_ALPHANUMERIC = /[^a-z0-9]+/gi;

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'general';
