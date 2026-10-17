// Se este arquivo fosse executado, criaria um marcador. O Rastro nunca executa código analisado.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../EXECUTED.marker', import.meta.url), 'executado');
