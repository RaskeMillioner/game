# RED TIDE

A one-thumb iPhone game: a swarm of red stickmen sprints at your blue squad. Your squad
auto-fires forward, grows through gates and shootable structures, and every red that gets
past the line takes a body with it.

Played at [raskemillioner.github.io/game](https://raskemillioner.github.io/game/).

See [`docs/PLAN.md`](docs/PLAN.md) for the design and development plan.

## Development

```sh
npm install
npm run dev      # local dev server
npm test         # vitest, headless sim tests
npm run build    # tsc --noEmit && vite build
```

## Balance tools

The sim is DOM-free, so balance is measured rather than guessed. Both tools bundle with
esbuild and run headless under Node:

```sh
# Survival curves, per-type attribution, per-level win rate against a target ramp.
npx esbuild src/tools/probe.ts --bundle --platform=node --format=esm \
  --outfile=.probe.mjs && node .probe.mjs

# Effective weapon power against a saturated target field.
npx esbuild src/tools/weapons.ts --bundle --platform=node --format=esm \
  --outfile=.weapons.mjs && node .weapons.mjs
```
