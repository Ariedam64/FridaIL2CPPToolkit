# Dofus 3.0 — Protocol schema (recovered from decompiled IL)

Extracted by walking decompiled `Ankama.Dofus.Protocol.Game.dll` (Cpp2IL → ilspycmd).

## Stats

- **1323** Protobuf message classes (top-level, implementing `IMessage<Self>`)
- **5462** total fields recovered with their tag + type
- Field NAMES are obfuscated; tags + types reveal the wire schema

## Top field types

| Type | Count |
|---|---|
| `int` | 1538 |
| `long` | 702 |
| `readonly RepeatedField` | 662 |
| `bool` | 565 |
| `string` | 546 |
| `readonly MapField` | 156 |
| `object` | 83 |
| `float` | 22 |
| `knl` | 21 |
| `jyl` | 20 |
| `ker` | 20 |
| `knj` | 14 |
| `gwj` | 12 |
| `kll` | 12 |
| `jyw` | 12 |

## Largest messages (potential envelopes / common types)

Messages with many fields are typically aggregator types (entity info, fight state, etc).

| Obf | Fields | Sample tag→type |
|---|---|---|
| `ixc` | 137 | 1=`int`, 2=`readonly RepeatedField<lo`, 3=`bool`, 4=`int`, 1=`long`, 2=`int`... |
| `khe` | 132 | 1=`kex.kew`, 2=`int`, 3=`knl`, 1=`readonly RepeatedField<kf`, 1=`ker`, 2=`jyn`... |
| `iyn` | 63 | 1=`int`, 2=`int`, 3=`float`, 4=`int`, 5=`float`, 6=`int`... |
| `knj` | 63 | 1=`long`, 2=`int`, 3=`string`, 1=`long`, 2=`long`, 3=`long`... |
| `kjw` | 55 | 1=`int`, 2=`kiz.kiy`, 3=`khn`, 4=`long`, 5=`string`, 6=`int`... |
| `kds` | 50 | 1=`kcu.kct`, 2=`long`, 3=`readonly RepeatedField<kd`, 1=`int`, 2=`readonly RepeatedField<lo`, 3=`string`... |
| `gxz` | 43 | 1=`int`, 2=`string`, 3=`string`, 4=`long`, 5=`readonly RepeatedField<lo`, 6=`int`... |
| `jlk` | 35 | 1=`string`, 2=`jlg.jle`, 3=`jlg.jld`, 4=`jlg.jlf`, 5=`long`, 1=`readonly MapField<int, in`... |
| `hhj` | 30 | 1=`int`, 2=`hhh`, 3=`int`, 4=`readonly RepeatedField<hh`, 5=`bool`, 6=`readonly RepeatedField<hh`... |
| `jkd` | 25 | 1=`readonly RepeatedField<jk`, 2=`int`, 3=`int`, 1=`jjh`, 2=`string`, 1=`readonly MapField<long, s`... |
| `jql` | 25 | 1=`readonly MapField<bool, i`, 2=`long`, 3=`long`, 4=`long`, 5=`long`, 1=`bool`... |
| `kaq` | 24 | 1=`string`, 2=`readonly RepeatedField<lo`, 3=`long`, 4=`long`, 5=`bool`, 6=`int`... |
| `kbv` | 24 | 1=`int`, 2=`int`, 3=`int`, 4=`int`, 5=`int`, 6=`int`... |
| `hhu` | 22 | 1=`hge`, 2=`int`, 1=`readonly MapField<bool, b`, 2=`bool`, 3=`readonly RepeatedField<in`, 4=`readonly RepeatedField<bo`... |
| `lac` | 22 | 1=`readonly RepeatedField<lo`, 2=`long`, 3=`readonly RepeatedField<in`, 4=`readonly RepeatedField<in`, 5=`int`, 6=`string`... |
| `itz` | 20 | 1=`long`, 2=`readonly MapField<string,`, 3=`bool`, 4=`long`, 5=`long`, 1=`its.itr`... |
| `kkj` | 20 | 1=`kka`, 2=`kll`, 1=`readonly RepeatedField<in`, 2=`readonly RepeatedField<kk`, 3=`readonly RepeatedField<in`, 1=`kka`... |
| `ife` | 19 | 1=`int`, 2=`int`, 3=`string`, 4=`bool`, 5=`string`, 6=`int`... |
| `ipk` | 19 | 1=`long`, 2=`string`, 3=`string`, 4=`bool`, 5=`readonly RepeatedField<lo`, 1=`readonly MapField<long, s`... |
| `ksa` | 19 | 1=`bool`, 1=`krj.kri`, 1=`int`, 1=`bool`, 5=`readonly RepeatedField<st`, 1=`object`... |

## The envelope (`gui` — observed 89× at runtime)

`gui` has **2 fields**:

| Tag | Type | Backing field |
|---|---|---|
| 1 | `object` | `dudr` |
| 2 | `guh` | `duds` |

## Sample messages (first 30 by tag count)


### `hen` (18 fields)

| Tag | Type |
|---|---|
| 1 | `bool` |
| 2 | `int` |
| 3 | `int` |
| 4 | `string` |
| 5 | `long` |
| 6 | `bool` |
| 1 | `ker` |
| 2 | `jyl` |
| 3 | `int` |
| 4 | `kaq` |
| 5 | `jyk` |
| 6 | `string` |
| 7 | `int` |
| 8 | `hem.hel` |
| 9 | `long` |
| ... | _(3 more)_ |

### `ktu` (18 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `int` |
| 1 | `ksl` |
| 2 | `knl` |
| 3 | `string` |
| 4 | `int` |
| 5 | `bool` |
| 6 | `readonly MapField<int, ktt.kts>` |
| 7 | `string` |
| 8 | `string` |
| 9 | `readonly RepeatedField<ktp>` |
| 10 | `int` |
| 11 | `int` |
| 12 | `int` |
| 13 | `bool` |
| ... | _(3 more)_ |

### `iod` (17 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `string` |
| 3 | `long` |
| 4 | `readonly RepeatedField<jzd>` |
| 5 | `int` |
| 6 | `int` |
| 7 | `bool` |
| 8 | `int` |
| 9 | `int` |
| 10 | `int` |
| 11 | `int` |
| 12 | `string` |
| 13 | `readonly RepeatedField<int>` |
| 14 | `bool` |
| 15 | `readonly RepeatedField<int>` |
| ... | _(2 more)_ |

### `jkx` (17 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `int` |
| 3 | `bool` |
| 4 | `string` |
| 5 | `string` |
| 6 | `int` |
| 7 | `int` |
| 8 | `readonly RepeatedField<jkm>` |
| 9 | `int` |
| 10 | `bool` |
| 11 | `int` |
| 12 | `jjh` |
| 13 | `int` |
| 14 | `readonly RepeatedField<jjr>` |
| 15 | `string` |
| ... | _(2 more)_ |

### `kaz` (17 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `int` |
| 3 | `int` |
| 4 | `kaw.kav` |
| 1 | `int` |
| 2 | `int` |
| 3 | `int` |
| 4 | `kay.kau` |
| 5 | `int` |
| 6 | `long` |
| 7 | `int` |
| 8 | `int` |
| 9 | `readonly RepeatedField<kay.kax>` |
| 10 | `bool` |
| 11 | `jyw` |
| ... | _(2 more)_ |

### `kbf` (17 fields)

| Tag | Type |
|---|---|
| 1 | `string` |
| 2 | `int` |
| 3 | `kma` |
| 4 | `readonly RepeatedField<jzp>` |
| 5 | `int` |
| 6 | `knl` |
| 7 | `ker` |
| 8 | `readonly RepeatedField<klz>` |
| 9 | `readonly RepeatedField<klz>` |
| 10 | `long` |
| 11 | `readonly RepeatedField<khu>` |
| 12 | `long` |
| 13 | `readonly RepeatedField<jzw>` |
| 14 | `string` |
| 15 | `int` |
| ... | _(2 more)_ |

### `kvz` (17 fields)

| Tag | Type |
|---|---|
| 1 | `readonly RepeatedField<long>` |
| 2 | `string` |
| 3 | `long` |
| 4 | `long` |
| 5 | `bool` |
| 6 | `int` |
| 7 | `readonly RepeatedField<bool>` |
| 8 | `readonly MapField<long, long>` |
| 9 | `readonly RepeatedField<int>` |
| 1 | `int` |
| 2 | `int` |
| 3 | `string` |
| 4 | `int` |
| 5 | `int` |
| 6 | `bool` |
| ... | _(2 more)_ |

### `lbn` (17 fields)

| Tag | Type |
|---|---|
| 1 | `long` |
| 2 | `int` |
| 3 | `lbe.lbd` |
| 4 | `string` |
| 1 | `lbi.lbg` |
| 2 | `lbi.lbg` |
| 3 | `lbi.lbh` |
| 4 | `int` |
| 5 | `int` |
| 1 | `int` |
| 2 | `readonly RepeatedField<lbk.lbj>` |
| 3 | `long` |
| 4 | `ker` |
| 5 | `readonly RepeatedField<lbk.lbf>` |
| 1 | `readonly RepeatedField<lbm.lbl>` |
| ... | _(2 more)_ |

### `hoh` (16 fields)

| Tag | Type |
|---|---|
| 1 | `long` |
| 2 | `readonly MapField<string, long>` |
| 3 | `bool` |
| 4 | `bool` |
| 5 | `readonly RepeatedField<string>` |
| 1 | `int` |
| 2 | `int` |
| 3 | `hnx.hnw` |
| 1 | `int` |
| 2 | `hoa.hnz` |
| 1 | `hoe.hod` |
| 2 | `hog.hob` |
| 3 | `string` |
| 5 | `long` |
| 1 | `object` |
| ... | _(1 more)_ |

### `iii` (16 fields)

| Tag | Type |
|---|---|
| 1 | `long` |
| 1 | `readonly MapField<long, int>` |
| 1 | `int` |
| 2 | `object` |
| 3 | `iia` |
| 4 | `string` |
| 1 | `bool` |
| 2 | `bool` |
| 3 | `jyl` |
| 4 | `long` |
| 5 | `int` |
| 6 | `int` |
| 7 | `int` |
| 1 | `string` |
| 2 | `iih.iif` |
| ... | _(1 more)_ |

### `jhb` (16 fields)

| Tag | Type |
|---|---|
| 1 | `readonly RepeatedField<bool>` |
| 2 | `int` |
| 3 | `long` |
| 4 | `bool` |
| 5 | `long` |
| 1 | `int` |
| 2 | `string` |
| 1 | `jgy.jgx` |
| 2 | `jgy.jgw` |
| 3 | `jgy.jgw` |
| 4 | `float` |
| 5 | `khn` |
| 3 | `jha.jgv` |
| 4 | `jha.jgu` |
| 1 | `object` |
| ... | _(1 more)_ |

### `jpg` (16 fields)

| Tag | Type |
|---|---|
| 1 | `bool` |
| 2 | `string` |
| 3 | `long` |
| 4 | `bool` |
| 5 | `long` |
| 1 | `int` |
| 2 | `string` |
| 3 | `kbz` |
| 4 | `long` |
| 5 | `int` |
| 6 | `jpd.jpc` |
| 1 | `long` |
| 2 | `kej` |
| 3 | `jyj` |
| 4 | `jyj` |
| ... | _(1 more)_ |

### `jqu` (16 fields)

| Tag | Type |
|---|---|
| 1 | `readonly MapField<string, string>` |
| 2 | `readonly RepeatedField<int>` |
| 3 | `int` |
| 4 | `int` |
| 5 | `bool` |
| 6 | `long` |
| 1 | `readonly MapField<long, bool>` |
| 2 | `long` |
| 3 | `long` |
| 4 | `string` |
| 5 | `long` |
| 1 | `jqq.jqp` |
| 1 | `kej` |
| 3 | `jqt.jqo` |
| 1 | `object` |
| ... | _(1 more)_ |

### `kae` (16 fields)

| Tag | Type |
|---|---|
| 1 | `long` |
| 2 | `long` |
| 3 | `readonly RepeatedField<string>` |
| 4 | `bool` |
| 5 | `long` |
| 6 | `bool` |
| 7 | `readonly MapField<string, int>` |
| 8 | `string` |
| 9 | `readonly MapField<string, int>` |
| 1 | `kie` |
| 2 | `int` |
| 3 | `kab.kaa` |
| 1 | `kad.kac` |
| 2 | `int` |
| 3 | `int` |
| ... | _(1 more)_ |

### `kqu` (16 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `int` |
| 3 | `int` |
| 1 | `int` |
| 2 | `kpp` |
| 3 | `int` |
| 4 | `kqr.kqq` |
| 5 | `int` |
| 6 | `int` |
| 7 | `int` |
| 8 | `int` |
| 9 | `int` |
| 10 | `int` |
| 1 | `kqt.kqp` |
| 2 | `readonly RepeatedField<kqt.kqs>` |
| ... | _(1 more)_ |

### `kwy` (16 fields)

| Tag | Type |
|---|---|
| 1 | `bool` |
| 2 | `string` |
| 3 | `string` |
| 4 | `string` |
| 5 | `readonly MapField<string, string>` |
| 6 | `long` |
| 7 | `readonly MapField<bool, string>` |
| 8 | `readonly RepeatedField<bool>` |
| 9 | `bool` |
| 1 | `long` |
| 2 | `int` |
| 3 | `int` |
| 4 | `kwv.kwu` |
| 5 | `bool` |
| 6 | `bool` |
| ... | _(1 more)_ |

### `jev` (15 fields)

| Tag | Type |
|---|---|
| 1 | `readonly RepeatedField<long>` |
| 2 | `long` |
| 3 | `readonly RepeatedField<string>` |
| 4 | `bool` |
| 5 | `string` |
| 6 | `int` |
| 7 | `readonly RepeatedField<int>` |
| 8 | `bool` |
| 1 | `readonly RepeatedField<long>` |
| 2 | `bool` |
| 1 | `long` |
| 2 | `jeu.jes` |
| 3 | `jeu.jet` |
| 4 | `jeu.jet` |
| 5 | `int` |

### `kkn` (15 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `kkm.kkk` |
| 3 | `string` |
| 4 | `int` |
| 5 | `int` |
| 6 | `khp` |
| 7 | `int` |
| 8 | `int` |
| 9 | `bool` |
| 10 | `kkm.kkl` |
| 11 | `khp` |
| 12 | `int` |
| 13 | `long` |
| 14 | `int` |
| 15 | `int` |

### `kny` (15 fields)

| Tag | Type |
|---|---|
| 1 | `bool` |
| 2 | `bool` |
| 3 | `int` |
| 4 | `string` |
| 5 | `int` |
| 6 | `long` |
| 7 | `jym` |
| 8 | `string` |
| 9 | `kaq` |
| 10 | `int` |
| 11 | `string` |
| 12 | `jyj` |
| 13 | `bool` |
| 14 | `long` |
| 15 | `ker` |

### `hou` (14 fields)

| Tag | Type |
|---|---|
| 1 | `long` |
| 2 | `readonly RepeatedField<int>` |
| 3 | `readonly RepeatedField<bool>` |
| 4 | `readonly MapField<string, int>` |
| 5 | `string` |
| 6 | `long` |
| 7 | `bool` |
| 8 | `readonly RepeatedField<string>` |
| 9 | `bool` |
| 1 | `hor.hoq` |
| 2 | `hpv` |
| 1 | `hot.hos` |
| 2 | `object` |
| 3 | `hoo` |

### `iqs` (14 fields)

| Tag | Type |
|---|---|
| 1 | `string` |
| 2 | `string` |
| 3 | `int` |
| 4 | `string` |
| 5 | `string` |
| 6 | `string` |
| 7 | `string` |
| 8 | `string` |
| 9 | `string` |
| 10 | `int` |
| 11 | `string` |
| 12 | `string` |
| 13 | `string` |
| 14 | `string` |

### `jjr` (14 fields)

| Tag | Type |
|---|---|
| 1 | `readonly MapField<bool, int>` |
| 2 | `readonly RepeatedField<string>` |
| 3 | `int` |
| 4 | `readonly RepeatedField<bool>` |
| 5 | `bool` |
| 6 | `string` |
| 7 | `bool` |
| 8 | `bool` |
| 9 | `string` |
| 1 | `int` |
| 2 | `readonly RepeatedField<long>` |
| 3 | `kbv` |
| 4 | `jjq.jjp` |
| 5 | `int` |

### `kmb` (14 fields)

| Tag | Type |
|---|---|
| 1 | `int` |
| 2 | `int` |
| 3 | `string` |
| 4 | `string` |
| 5 | `jzd` |
| 6 | `readonly RepeatedField<int>` |
| 7 | `bool` |
| 8 | `int` |
| 9 | `bool` |
| 10 | `readonly RepeatedField<int>` |
| 11 | `bool` |
| 12 | `long` |
| 13 | `bool` |
| 14 | `string` |

### `kvm` (14 fields)

| Tag | Type |
|---|---|
| 1 | `bool` |
| 2 | `long` |
| 3 | `long` |
| 4 | `string` |
| 5 | `string` |
| 6 | `readonly RepeatedField<int>` |
| 7 | `string` |
| 8 | `bool` |
| 9 | `long` |
| 1 | `kvl.kvk` |
| 2 | `readonly RepeatedField<int>` |
| 3 | `readonly RepeatedField<khn>` |
| 4 | `readonly RepeatedField<int>` |
| 5 | `readonly RepeatedField<int>` |

### `gvz` (13 fields)

| Tag | Type |
|---|---|
| 1 | `long` |
| 2 | `readonly MapField<bool, string>` |
| 3 | `bool` |
| 4 | `string` |
| 5 | `int` |
| 6 | `int` |
| 1 | `gun` |
| 2 | `int` |
| 3 | `gvv.gvu` |
| 4 | `gvc` |
| 5 | `readonly RepeatedField<gvc>` |
| 1 | `object` |
| 2 | `gvt` |

### `hnu` (13 fields)

| Tag | Type |
|---|---|
| 1 | `string` |
| 2 | `readonly MapField<string, long>` |
| 3 | `int` |
| 4 | `long` |
| 5 | `bool` |
| 6 | `string` |
| 7 | `int` |
| 8 | `bool` |
| 9 | `bool` |
| 1 | `bool` |
| 2 | `hnt.hnr` |
| 3 | `hpv` |
| 4 | `hnt.hns` |

### `hvf` (13 fields)

| Tag | Type |
|---|---|
| 1 | `readonly MapField<bool, long>` |
| 2 | `long` |
| 3 | `string` |
| 1 | `readonly RepeatedField<knj>` |
| 2 | `long` |
| 3 | `string` |
| 4 | `hrt` |
| 5 | `string` |
| 6 | `readonly RepeatedField<hur>` |
| 7 | `int` |
| 8 | `int` |
| 9 | `long` |
| 10 | `hve.hvd` |

### `ija` (13 fields)

| Tag | Type |
|---|---|
| 1 | `string` |
| 2 | `int` |
| 3 | `bool` |
| 4 | `readonly RepeatedField<string>` |
| 5 | `long` |
| 6 | `bool` |
| 1 | `iiu.iit` |
| 2 | `string` |
| 3 | `iii` |
| 1 | `iix.iiw` |
| 3 | `bool` |
| 1 | `object` |
| 2 | `iis` |

### `iso` (13 fields)

| Tag | Type |
|---|---|
| 1 | `readonly RepeatedField<khs>` |
| 2 | `bool` |
| 3 | `readonly RepeatedField<isi>` |
| 4 | `readonly RepeatedField<kdu>` |
| 5 | `int` |
| 7 | `int` |
| 9 | `long` |
| 11 | `readonly RepeatedField<kkj>` |
| 12 | `readonly RepeatedField<iro>` |
| 13 | `readonly RepeatedField<kmi>` |
| 16 | `readonly RepeatedField<khe>` |
| 6 | `object` |
| 8 | `isn` |

### `jaj` (13 fields)

| Tag | Type |
|---|---|
| 1 | `readonly MapField<long, bool>` |
| 2 | `long` |
| 3 | `bool` |
| 4 | `bool` |
| 5 | `bool` |
| 6 | `long` |
| 7 | `readonly RepeatedField<bool>` |
| 8 | `int` |
| 9 | `bool` |
| 1 | `readonly RepeatedField<hdj>` |
| 2 | `long` |
| 3 | `jai.jah` |
| 4 | `readonly RepeatedField<kmf>` |
