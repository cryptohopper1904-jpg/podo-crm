/** Nur interne, einfache Pfade (kein //, kein \\, keine Schemata) – für Rücksprungziele aus URLs/Sitzung */
export const isSafeReturnPath = (p: string) => p.length <= 300 && /^\/(?!\/)[\w\-/?=&.%]*$/.test(p);
