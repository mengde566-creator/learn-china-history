/** 三位来源编号；带「年」的三位纪年和较长数字不作为编号。 */
export function sourceReferences(text) {
  return String(text ?? '').matchAll(/(?<!\d)(\d{3})(?!\d)(?!\s*年)/g)
}
