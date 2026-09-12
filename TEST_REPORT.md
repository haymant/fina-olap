# TEST_REPORT.md — fina-olap OLAP engine, seed fixture sample.parquet

Live sample outputs generated end-to-end through `OlapEngine.query` — the same code path the REST, MCP and Vercel surfaces use. Numeric measures are truncated for readability.

## Scenario 1: Top-level grouping by Portfolio
Displays the 5 distinct portfolios with sum(delta) via the REST/engine path.
* `lastRow=5` · `rows=5` · `success=True`

| portfolio | delta |
| --- | ---: |
| Portfolio 1 | 7.453806277558589 |
| Portfolio 2 | 15.337032121344205 |
| Portfolio 3 | 23.32330635322596 |
| Portfolio 4 | 22.904264614223603 |
| Portfolio 5 | 7.410387930346767 |

## Scenario 2: Sub-grouping: instruments under Portfolio 1
Expands Portfolio 1 to its 100 instrument children (page of 5).
* `lastRow=-1` · `rows=5` · `success=True`

| portfolio | instrument |
| --- | --- |
| Portfolio 1 | Instrument 1 |
| Portfolio 1 | Instrument 10 |
| Portfolio 1 | Instrument 100 |
| Portfolio 1 | Instrument 11 |
| Portfolio 1 | Instrument 12 |

## Scenario 3: Sub-grouping: legs under Portfolio 1 / Instrument 1
Drills one more level to the 3 legs.
* `lastRow=3` · `rows=3` · `success=True`

| portfolio | instrument | leg |
| --- | --- | --- |
| Portfolio 1 | Instrument 1 | funding |
| Portfolio 1 | Instrument 1 | note |
| Portfolio 1 | Instrument 1 | put |

## Scenario 4: Sorting: portfolios descending
Sets sortModel on the output column only.
* `lastRow=5` · `rows=5` · `success=True`

| portfolio |
| --- |
| Portfolio 5 |
| Portfolio 4 |
| Portfolio 3 |
| Portfolio 2 |
| Portfolio 1 |

## Scenario 5: Advanced filtering + multi-level expansion
portfolio in {1,2,3} AND instrument in {2,4}; Portfolio 1 only matches.
* `lastRow=2` · `rows=2` · `success=True`

| portfolio | instrument | delta |
| --- | --- | ---: |
| Portfolio 1 | Instrument 2 | 0.08959121870060471 |
| Portfolio 1 | Instrument 4 | 0.08864949859786077 |

## Scenario 6: Pivot by leg across delta/gamma/vega
Pivot mode over 3 value columns; pivoted column names follow `{leg}_{field}`.
* `lastRow=5` · `rows=5` · `success=True`

| portfolio | funding_delta | funding_gamma | funding_vega | note_delta | note_gamma | note_vega | put_delta | put_gamma | put_vega |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Portfolio 1 | 2.447049655243521 | 0.23959982849804592 | 0.23839638147938247 | 2.435512477817237 | 0.23642926096208255 | 0.2662649689643724 | 2.5712441444978307 | 0.2660830783814246 | 0.21448215053926414 |
| Portfolio 2 | 5.244492423314318 | 0.4951869614308167 | 0.527869460122215 | 5.048701640198429 | 0.5348424044565501 | 0.47051947391925236 | 5.043838057831476 | 0.5170070004225881 | 0.5299631138021964 |
| Portfolio 3 | 7.75345305298548 | 0.7476832614147618 | 0.7629831223516333 | 7.879399795790466 | 0.7347565821058564 | 0.7640585766853358 | 7.690453504450047 | 0.7403540626799244 | 0.8041268283668064 |
| Portfolio 4 | 7.379918710582316 | 0.7515557249515331 | 0.7752643063358821 | 7.809124671755483 | 0.7457816936138899 | 0.809133357043058 | 7.7152212318857885 | 0.7099709319358632 | 0.7483542902839911 |
| Portfolio 5 | 2.533441564924057 | 0.26467669956920187 | 0.27332337869596307 | 2.540924923006065 | 0.2651808854649798 | 0.2532814954711986 | 2.3360214424166488 | 0.25354626835125477 | 0.23391158574175616 |

## Scenario 7: Custom aggregation: first() at the leg level only
aggFuncsByLevel = {'leg': 'first'} leaves other levels un-aggregated.
* `lastRow=3` · `rows=3` · `success=True`

| portfolio | instrument | leg | delta |
| --- | --- | --- | ---: |
| Portfolio 1 | Instrument 1 | funding | 0.043071298075657745 |
| Portfolio 1 | Instrument 1 | note | 0.022505043547850566 |
| Portfolio 1 | Instrument 1 | put | 0.038923846379242205 |

## Scenario 8: Grand total row
includeGrandTotal prepends a NULL-group row with whole-table aggregates.
* `lastRow=6` · `rows=6` · `success=True`

| portfolio | delta |
| --- | ---: |
| *(null)* | 76.42879729669919 |
| Portfolio 1 | 7.453806277558589 |
| Portfolio 2 | 15.337032121344205 |
| Portfolio 3 | 23.32330635322596 |
| Portfolio 4 | 22.904264614223603 |
| Portfolio 5 | 7.410387930346767 |

## Scenario 9: Level-of-Detail (fixed) join
lodConfig fixed on portfolio; every row carries _lod_delta (portfolio sum).
* `lastRow=-1` · `rows=8` · `success=True`

| portfolio | instrument | delta | _lod_delta |
| --- | --- | ---: | --- |
| Portfolio 1 | Instrument 16 | 0.0755479711824038 | 7.453806277558589 |
| Portfolio 1 | Instrument 15 | 0.09339968569419507 | 7.453806277558589 |
| Portfolio 1 | Instrument 14 | 0.09804256137102126 | 7.453806277558589 |
| Portfolio 1 | Instrument 13 | 0.04379425325000219 | 7.453806277558589 |
| Portfolio 1 | Instrument 12 | 0.053444856943353165 | 7.453806277558589 |
| Portfolio 1 | Instrument 11 | 0.10286676507752877 | 7.453806277558589 |
| Portfolio 1 | Instrument 100 | 0.11197534815498304 | 7.453806277558589 |
| Portfolio 1 | Instrument 10 | 0.046175968343764334 | 7.453806277558589 |

## Scenario 10: Per-level visibility: qty only at the portfolio level
visibleLevels=[0] suppresses qty (NULL) one level down.
* `lastRow=-1` · `rows=7` · `success=True`

| portfolio | instrument | qty |
| --- | --- | ---: |
| Portfolio 1 | Instrument 1 | *(null)* |
| Portfolio 1 | Instrument 10 | *(null)* |
| Portfolio 1 | Instrument 100 | *(null)* |
| Portfolio 1 | Instrument 11 | *(null)* |
| Portfolio 1 | Instrument 12 | *(null)* |
| Portfolio 1 | Instrument 13 | *(null)* |
| Portfolio 1 | Instrument 14 | *(null)* |

## Python test + coverage
`pytest 3000 fixture rows, 10 scenarios` — coverage JSON from `coverage.json`.

| Module | Coverage |
| --- | --- |
| `src/fina_olap/__init__.py` | 100.0% |
| `src/fina_olap/__main__.py` | 0.0% |
| `src/fina_olap/builder.py` | 88.0% |
| `src/fina_olap/cli.py` | 65.3% |
| `src/fina_olap/engine.py` | 90.4% |
| `src/fina_olap/export.py` | 96.7% |
| `src/fina_olap/fixture.py` | 92.3% |
| `src/fina_olap/gcs.py` | 56.7% |
| `src/fina_olap/mcp_server.py` | 85.6% |
| `src/fina_olap/schema.py` | 94.0% |
| `src/fina_olap/server.py` | 95.7% |
| `src/fina_olap/storage.py` | 97.9% |
| `src/fina_olap/upsert.py` | 85.4% |
| `src/fina_olap/vercel.py` | 78.9% |
| **Total** | **87.5%** |
