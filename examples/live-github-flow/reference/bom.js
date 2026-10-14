export function stripBom(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value;
}
