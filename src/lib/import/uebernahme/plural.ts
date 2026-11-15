/** „1 Termin“ / „3 Termine“ – Einzahl/Mehrzahl für Zähltexte des Übernahme-Assistenten */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
