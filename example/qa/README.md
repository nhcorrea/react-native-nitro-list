# QA fixtures — asserts que moram no app

A tela **QA** do example (`QAFixturesScreen.tsx`, chip "QA" no stress lab)
cobre a classe de comportamento que o harness jest **não** consegue exercer:
gesto real, fling com física da plataforma e MVCP nativo aplicado pelo
ScrollView de verdade.

Cada fixture verifica a si mesma e expõe o resultado como `testID`:

| Fixture | testID de sucesso | O que verifica |
|---|---|---|
| fling-blank | `qa-fling-blank-pass` | Após um fling real (≥60 samples), blank frames ≤ 2% do total (PerfMonitor). |
| scroll-to-index | `qa-scroll-to-index-pass` | `scrollToIndex(7333)` aterrissa a ≤1dp do offset exato do item. |
| scroll-to-end | `qa-scroll-to-end-pass` | `scrollToEnd` aterrissa a ≤1dp do offset máximo real. |
| mvcp-prepend | `qa-mvcp-prepend-pass` | 10 prepends com MVCP ativo: âncora visível deriva ≤2dp no total. |

Estados intermediários usam `qa-<nome>-idle`, `qa-<nome>-running`,
`qa-<nome>-fail` — a automação só precisa esperar o `-pass` aparecer.

## Automação

O flow [`qa-fixtures.yaml`](qa-fixtures.yaml) roda com
[Maestro](https://maestro.mobile.dev) num device/emulador com o example
instalado em **release**:

```sh
cd example
# android
yarn android --mode release
maestro test qa/qa-fixtures.yaml
```

O assert mora no app: o flow só toca botões e espera os `*-pass` — qualquer
regressão de aterrissagem/blank/MVCP falha o flow sem lógica no script.

> Medições contínuas (tick p50/p95/p99, `mountBurst`, `firstRange` etc.)
> ficam no HUD do stress lab e na tela de bench; esta tela é só o go/no-go
> comportamental de gesto real.
