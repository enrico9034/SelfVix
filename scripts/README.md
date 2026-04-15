# Script di sviluppo

Piccole utility per smoke-test e benchmark di un'istanza SelfVix in
esecuzione. Entrambi gli script funzionano contro qualunque istanza
raggiungibile — locale (`http://127.0.0.1:7000`) o deployata
(`https://tuo-dominio`).

## `test-streams.sh`

Interroga `/stream/<type>/<id>.json` su una matrice fissa di casi (film,
serie, anime, film anime, ID da IMDb / TMDB / Kitsu) e riporta quanti
stream ciascuno ha restituito. Utile come check di regressione dopo
modifiche al handler degli stream. Funziona sia su istanza locale che su
istanza remota deployata.

```sh
# locale (default http://127.0.0.1:7000)
./scripts/test-streams.sh

# locale su porta custom
PORT=7020 ./scripts/test-streams.sh

# istanza remota — tre forme equivalenti
./scripts/test-streams.sh https://selfvix.example.com
./scripts/test-streams.sh --base https://selfvix.example.com
BASE=https://selfvix.example.com ./scripts/test-streams.sh
```

Note:

- Se non specifichi nulla, parte dal presupposto che l'addon sia su
  `http://127.0.0.1:$PORT` (default `7000`).
- Richiede `curl` e `node` nel `PATH` (per un piccolo parsing JSON inline).
- Se `AU_PROXY` non è configurato sull'istanza testata e l'host è su un
  ASN bannato da AnimeUnity (Oracle / Hetzner / ecc), i casi che dipendono
  da AU restituiranno 0 stream.

## `bench.py`

Misura il **time-to-first-byte (TTFB)** e il tempo totale di download di
un singolo segmento HLS che passa dal proxy dell'addon. Il TTFB è la
metrica che determina davvero la latenza di avvio riproduzione — un TTFB
basso significa che il proxy sta streammando il segmento invece di
bufferizzarlo in RAM.

```sh
# Risoluzione automatica: lista stream → master → media → primo segmento → bench
./scripts/bench.py --base https://tuo-dominio --id kitsu:46474:1

# Contenuto / variante diversi
./scripts/bench.py --base https://tuo-dominio \
    --type series --id tt22248376:1:1 --stream-index 1 -n 10

# Benchmark di un URL segmento specifico
./scripts/bench.py --segment-url 'https://tuo-dominio/proxy/hls/segment.ts?token=…' -n 5
```

L'output etichetta automaticamente il risultato:

- `TTFB / Total ratio < 50%` → streaming ✅ (il player parte subito)
- `TTFB / Total ratio ≥ 50%` → bufferizza l'intero segmento ❌

Solo stdlib Python, nessun `pip install` richiesto.
