# Bitcoin Tontine — Reglas Oficiales del Protocolo
*Documento de diseño pre-código — aprobado por ceob68*

---

## 1. ESTRUCTURA DEL POOL

- Cada pool acepta exactamente **50 jugadores históricos** (activos + liquidados)
- Entrada fija: **10 tokens OP_20**
- Los pools son **completamente independientes** entre sí — sin mezcla de fondos ni puntos
- Cuando un pool completa sus 50 históricos, el sistema abre automáticamente un Pool nuevo
- Un jugador puede participar en múltiples pools simultáneamente

---

## 2. INICIO DEL JUEGO

- El pool necesita mínimo **5 jugadores** (10% de 50) para activarse
- Una vez llegado el jugador #5, hay una espera de **24 horas** antes de que arranquen los relojes
- Durante esas 24 horas siguen entrando jugadores libremente
- Los jugadores que entren después del inicio tienen su propio reloj calculado desde su momento de entrada

---

## 3. SISTEMA DE PING

### Reloj personalizado
- Cada jugador tiene su propio reloj individual — no hay reloj global del pool
- El reloj se calcula desde el momento exacto en que el jugador hizo su último ping
- Ejemplo: Jugador A hace ping a las 21:20 → su próximo vencimiento es exactamente 7 días después a las 21:20

### Aceleración progresiva
- Intervalo inicial: **7 días**
- Cada día que pasa el intervalo se reduce automáticamente
- Intervalo mínimo: **1 hora**
- La aceleración aplica al **siguiente ciclo** — nunca sorprende al jugador a mitad de un ciclo
- Cuando el jugador hace ping, el sistema le calcula y muestra la fecha/hora exacta de su próximo ping con el nuevo intervalo vigente

### Avisos
- El frontend avisa al jugador cuándo debe hacer su próximo ping
- Es responsabilidad del jugador estar pendiente — el que quiera ganar que esté despierto

### Muerte por inactividad
- Si el jugador no hace ping antes de su vencimiento, queda disponible para liquidación
- El sistema abre una **ventana de 1 minuto** visible para TODOS los jugadores del pool
- Si nadie liquida en ese minuto, el jugador muere igualmente por inactividad automática

---

## 4. SISTEMA DE CACERÍA (LIQUIDACIÓN MANUAL)

### Cuándo se activa
- Las liquidaciones manuales solo están disponibles cuando el pool ha recorrido el **70% de su vida de aceleración**
- Antes de ese punto no existe la opción de cazar

### Cuántas balas existen
- Solo **3 liquidaciones manuales** en toda la vida del pool
- Una vez usadas las 3, no hay más cacería manual — solo muerte por inactividad

### Quién puede cazar
- Cualquier jugador activo puede activar UNA liquidación en toda su vida en ese pool
- Si la usas, no tienes más — aunque queden balas disponibles del pool

### El proceso de caza — dos fases

**Fase 1: El cazador declara**
- El cazador llama al contrato e indica a quién quiere liquidar
- El contrato registra cazador y cazado públicamente
- Se abre una ventana de **exactamente 1 minuto** visible para todo el pool
- El cazador queda **expuesto** — todos saben quién está cazando a quién

**Fase 2: La ventana de 1 minuto**

*Escenario A — El cazado no reacciona:*
- El cazador confirma la liquidación después del minuto
- El cazador cobra su recompensa
- La bala del pool se consume (-1 de las 3)

*Escenario B — El cazado hace ping dentro del minuto:*
- La caza se cancela automáticamente
- El cazador **pierde su única bala** para siempre
- El cazador paga una **penalización del 5%** de su depósito
- Ese 5% va directo al cazado como recompensa por haber respondido
- La bala del pool NO se consume — se conserva para otro momento

*Escenario C — El tiempo del cazado había expirado pero hace ping en el minuto:*
- Si el cazado aún no había vencido su ping y lo hace durante la ventana → Escenario B
- Si el cazado ya tenía su tiempo vencido y alguien lo caza → solo puede resolverse con Escenario A

---

## 5. SISTEMA DE PUNTOS Y DISTRIBUCIÓN JUSTA

### Acumulación de puntos
- Cada bloque que un jugador está activo en el pool acumula **1 punto**
- Los puntos NUNCA se resetean durante la vida del jugador en el pool
- Solo se resetean si el jugador muere o gana — si vuelve a entrar, empieza desde cero
- El jugador que lleva más tiempo tiene más puntos y recibe más de las liquidaciones

### Distribución de una liquidación

| Destino | Porcentaje | Condición |
|---------|-----------|-----------|
| Protocolo | 0.3% | Siempre, automático |
| Cazador | 10% | Solo si fue liquidación manual activa |
| Inactividad automática | 0% al cazador | El 10% va al pool general |
| Supervivientes | 89.7% | Proporcional a puntos de antigüedad |

### Ejemplo de reparto entre supervivientes
Si hay 4 supervivientes y el reparto es de 89.7 tokens:

| Jugador | Bloques activo | % del reparto | Recibe |
|---------|---------------|---------------|--------|
| A (veterano) | 2000 bloques | 52.6% | 47.2 tokens |
| B | 1000 bloques | 26.3% | 23.6 tokens |
| C | 600 bloques | 15.8% | 14.2 tokens |
| D (nuevo) | 200 bloques | 5.3% | 4.7 tokens |

---

## 6. ENTRADA DE NUEVOS JUGADORES

- Los jugadores pueden entrar al pool mientras no se hayan completado los 50 históricos
- El pool "lleno" es histórico — cuenta activos + liquidados
- Ejemplo: si hay 2 activos y 47 liquidados = 49 históricos → aún entra 1 más
- El nuevo entrante paga 10 tokens que van al pool
- El nuevo entrante empieza con 0 puntos — recibe menos del reparto inicialmente
- Su reloj de ping se calcula desde su momento de entrada con el intervalo vigente en ese momento

---

## 7. FIN DEL JUEGO

- El pool termina cuando queda **exactamente 1 jugador activo**
- El ganador reclama **todo el pool acumulado** (entradas iniciales + entradas de nuevos jugadores)
- El 0.3% del protocolo ya fue descontado en cada liquidación durante el juego
- No hay retiro voluntario — la única salida es morir o ganar

---

## 8. FEES DEL PROTOCOLO

- **0.3%** de cada liquidación va al treasury del protocolo automáticamente
- Este fee aplica tanto a liquidaciones manuales como a muertes por inactividad
- En mainnet este treasury es controlado por el deployer del contrato (ceob68)

---

## 9. PROTECCIÓN ANTI-BOT / ANTI-SYBIL

- Las 3 balas de cacería son escasas — usarlas para liquidarse a uno mismo es económicamente suicida
- Los puntos de antigüedad perjudican a las wallets nuevas — un atacante con múltiples wallets nuevas recibe casi nada del reparto
- La penalización del 5% por caza fallida desincentiva ataques por ensayo y error
- La ventana de ping aleatoria basada en block hash nivela bots vs humanos

---

## 10. VISIÓN MAINNET

- Fee actual en testnet: 0% (solo para demostración)
- Fee en mainnet: 0.3%
- Protecciones anti-ataque adicionales a implementar antes de mainnet
- Sistema de pools ilimitados — pueden correr decenas simultáneamente
- Compatible con cualquier token OP_20

---

*Reglas cerradas y aprobadas — listas para implementación*
*Fecha: Febrero 2026*
