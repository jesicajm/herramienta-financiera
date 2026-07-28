/* ═══════════════════════════════════════════════════════════
   FIREBASE — auth + firestore
   ═══════════════════════════════════════════════════════════ */
   console.log('%cABBA · build fiscal 2026-06-29-v89 · diagnóstico + vulnerabilidades + deducciones (dep336/387, GMF, vivienda auto, prepagada, FPV)', 'color:#0e4d3a;font-weight:bold');
   const firebaseConfig = {
    apiKey: "AIzaSyBLNS_xLAoAsnf5XfajAmVf12f4_mpUMfY",
    authDomain: "evaluafinanzas.firebaseapp.com",
    projectId: "evaluafinanzas",
    storageBucket: "evaluafinanzas.firebasestorage.app",
    messagingSenderId: "216050844635",
    appId: "1:216050844635:web:ca5700949ed37f45385dfe",
    measurementId: "G-WWS234JYZC"
  };
  
  let db=null, auth=null, firestoreAvailable=false, authAvailable=false;
  try {
    firebase.initializeApp(firebaseConfig);
    db=firebase.firestore();
    db.enablePersistence().catch(()=>{});
    firestoreAvailable=true;
    auth=firebase.auth();
    authAvailable=true;
  } catch(e){ console.warn('Firebase no configurado, usando localStorage.'); }

  /* ═══════════════════════════════════════════════════════════
     CONFIGURACIÓN FISCAL — parámetros por año (UVT, topes, tarifas, calendario)
     Fuente de verdad: Firestore  config/fiscal/anios/{año}  (editable sin re-desplegar).
     FISCAL_DEFAULT es el respaldo embebido por si el documento no carga.
     Valores en UVT salvo que se indique; al cambiar la UVT, los topes en pesos se recalculan solos.
     ═══════════════════════════════════════════════════════════ */
  const FISCAL_DEFAULT = {
    vigencia: { anio: 2026, fuente: 'UVT: Res. DIAN 000238/2025. Factores art. 73: Decreto 0449/2026 (AG 2025). Tarifas/calendario: verificar con DIAN y municipio.', actualizado: '2026-04-27', _respaldo: true },
    uvt: 52374,                                   // UVT 2026 oficial (DIAN)
    topesDeclaracion: { ingresosBrutos:1400, patrimonioBruto:4500, consumosTarjeta:1400, comprasConsumos:1400, consignaciones:1400 },
    // Impuesto al patrimonio (art. 292-3 a 297-3 · Ley 2277/2022, régimen permanente). Base = patrimonio LÍQUIDO al 1-ene.
    impuestoPatrimonio: {
      umbralUVT:72000,               // régimen permanente: obligado si patrimonio líquido ≥ 72.000 UVT
      umbralTemporal2026UVT:40000,   // Decreto 1474/2025 (emergencia, SOLO 2026, en revisión Corte Constitucional)
      exclusionViviendaUVT:12000,    // exclusión de la vivienda de habitación
      // Tarifas marginales (art. 296-3). acumUVT = impuesto acumulado hasta el 'desde' del rango.
      tabla: [
        { desde:0,      hasta:72000,  tarifa:0.000, acumUVT:0 },
        { desde:72000,  hasta:122000, tarifa:0.005, acumUVT:0 },
        { desde:122000, hasta:239000, tarifa:0.010, acumUVT:250 },   // (122000−72000)×0,5% = 250 UVT
        { desde:239000, hasta:null,   tarifa:0.015, acumUVT:1420 }   // 250 + (239000−122000)×1% = 1.420 UVT · 1,5% solo hasta 2026
      ]
    },
    renta: {
      // Tarifa marginal por rangos en UVT (art. 241 E.T.) — estable, no cambia con la UVT
      tabla241: [
        { desde:0,     hasta:1090,  tarifa:0.00, baseUVT:0 },
        { desde:1090,  hasta:1700,  tarifa:0.19, baseUVT:0 },
        { desde:1700,  hasta:4100,  tarifa:0.28, baseUVT:116 },
        { desde:4100,  hasta:8670,  tarifa:0.33, baseUVT:788 },
        { desde:8670,  hasta:18970, tarifa:0.35, baseUVT:2296 },
        { desde:18970, hasta:31000, tarifa:0.37, baseUVT:5901 },
        { desde:31000, hasta:null,  tarifa:0.39, baseUVT:10352 }
      ],
      limiteRentasExentasDeducciones: { pct:0.40, topeUVT:1340 },
      aporteVoluntario:        { pct:0.30, topeUVT:3800 },
      deduccionDependientes:   { pctIngreso:0.10, topeUVTmes:32, maxDependientes:4 },
      deduccionSalud:          { topeUVTmes:16 },     // medicina prepagada / pólizas
      deduccionInteresesVivienda: { topeUVTanio:1200 },
      rentaExentaLaboral:      { pct:0.25, topeUVTmes:790 }
    },
    gananciaOcasional: {
      tarifa:0.15, tarifaLoterias:0.20,
      // Exenciones de herencia (art. 307 · Ley 2277/2022) y seguros de vida (art. 303-1), en UVT.
      herencia: {
        viviendaCausanteUVT:13000,      // num 1: vivienda de habitación del causante
        otrosInmueblesCausanteUVT:6500,  // num 2: otros inmuebles del causante
        porBeneficiarioUVT:3250,         // num 3: por cónyuge/heredero legitimario (individual)
        noLegitimarioPct:0.20,           // num 4: 20% para no legitimarios/no cónyuge
        noLegitimarioTopeUVT:1625,       // num 4: tope
        seguroVidaUVT:3250               // art. 303-1: seguro de vida
      },
      // Factores de ajuste del costo fiscal por AÑO DE ADQUISICIÓN y TIPO de bien (art. 73).
      // IMPORTANTE: dependen del AÑO DE VENTA y los fija un decreto anual de la DIAN (ej. Decreto 0449/2026 para ventas del AG 2025).
      // Acciones/aportes usan IPC (factores bajos); bienes raíces usan el índice de propiedad raíz (factores altos).
      // Valores REFERENCIALES para una venta ~2025; el admin debe cargar la tabla oficial vigente en config/fiscal.
      // Tabla OFICIAL del Decreto 0449 del 27-04-2026 (factores del art. 73 para enajenaciones del año gravable 2025).
      // Por año de adquisición y tipo de bien. El factor del año de venta cambia cada año (nuevo decreto); actualizar entonces.
      factoresArt73: {
        _fuente: 'Decreto 0449/2026 (AG 2025)',
        acciones: { '1955':4664.64,'1956':4571.26,'1957':4232.67,'1958':3571.20,'1959':3264.90,'1960':3047.31,'1961':2856.78,'1962':2688.94,'1963':2511.50,'1964':1920.42,'1965':1758.11,'1966':1533.84,'1967':1352.33,'1968':1255.75,'1969':1178.09,'1970':1083.26,'1971':1011.41,'1972':896.22,'1973':788.01,'1974':643.73,'1975':514.87,'1976':437.78,'1977':349.06,'1978':273.72,'1979':228.64,'1980':180.64,'1981':145.15,'1982':115.48,'1983':92.79,'1984':79.70,'1985':67.49,'1986':55.27,'1987':45.67,'1988':37.23,'1989':29.17,'1990':23.14,'1991':17.54,'1992':13.82,'1993':11.09,'1994':9.05,'1995':7.41,'1996':6.28,'1997':5.41,'1998':4.61,'1999':3.97,'2000':3.64,'2001':3.36,'2002':3.13,'2003':2.93,'2004':2.75,'2005':2.61,'2006':2.48,'2007':2.37,'2008':2.24,'2009':2.07,'2010':2.03,'2011':1.97,'2012':1.90,'2013':1.85,'2014':1.82,'2015':1.75,'2016':1.64,'2017':1.56,'2018':1.50,'2019':1.45,'2020':1.40,'2021':1.38,'2022':1.30,'2023':1.15,'2024':1.05,'2025':1.00,'2026':1.00 },
        bienRaizUrbano: { '1955':36085.10,'1956':35363.86,'1957':32744.71,'1958':27626.91,'1959':25257.62,'1960':23574.13,'1961':21981.02,'1962':20800.81,'1963':19429.21,'1964':14857.22,'1965':13600.80,'1966':11865.93,'1967':10462.43,'1968':9714.61,'1969':9113.87,'1970':8380.22,'1971':7823.78,'1972':6934.19,'1973':6097.77,'1974':4981.35,'1975':3981.89,'1976':3386.47,'1977':2698.90,'1978':2117.65,'1979':1768.55,'1980':1398.18,'1981':1121.73,'1982':893.13,'1983':717.70,'1984':616.69,'1985':535.17,'1986':443.02,'1987':375.68,'1988':283.53,'1989':176.77,'1990':122.25,'1991':85.19,'1992':63.81,'1993':45.35,'1994':32.98,'1995':23.50,'1996':17.37,'1997':14.41,'1998':11.07,'1999':9.23,'2000':9.16,'2001':8.86,'2002':8.19,'2003':7.35,'2004':6.92,'2005':6.50,'2006':6.15,'2007':4.67,'2008':4.16,'2009':3.43,'2010':3.12,'2011':2.86,'2012':2.39,'2013':2.05,'2014':1.81,'2015':1.68,'2016':1.60,'2017':1.52,'2018':1.41,'2019':1.30,'2020':1.22,'2021':1.16,'2022':1.12,'2023':1.09,'2024':1.05,'2025':1.00,'2026':1.00 },
        bienRaizRuralAgro: { '1986':429.25,'1990':118.45,'1995':22.77,'2000':8.88,'2005':6.29,'2010':3.02,'2014':1.76,'2018':1.36,'2020':1.18,'2022':1.09,'2023':1.06,'2024':1.03,'2025':1.00,'2026':1.00 },
        bienRaizRural: { '1986':437.46,'1990':120.71,'1995':23.20,'2000':9.05,'2005':6.41,'2010':3.08,'2014':1.79,'2018':1.39,'2020':1.21,'2022':1.11,'2023':1.08,'2024':1.05,'2025':1.00,'2026':1.00 },
        base1986: { acciones:55.27, bienRaizUrbano:443.02, bienRaizRuralAgro:429.25, bienRaizRural:437.46 }
      }
    },
    iva: { tarifaGeneral:0.19, topeNoResponsableUVT:3500, periodicidadBimestralDesdeUVT:92000 },
    exogena: { ingresosPNUVT:11800, rentasCapNoLabPNUVT:2400, simplePNUVT:11800, sancionMinUVT:10, ventana:'mayo–junio 2026' },   // Res. DIAN 000227/2025 (AG 2025)
    activosExterior: { topeUVT:2000 },
    simple: {                                                // Art. 908 ET · post Sentencia C-540/23 · tarifa PLANA por rango (no marginal)
      topeIngresosUVT:100000,
      topeProfesionalesUVT:12000,                            // tope para servicios profesionales / profesiones liberales (grupo 4)
      grupos:[
        { id:1, nombre:'Tiendas, minimercados, peluquería', incConsumo:0, rangos:[
          {desde:0,hasta:6000,tarifa:0.012},{desde:6000,hasta:15000,tarifa:0.028},{desde:15000,hasta:30000,tarifa:0.044},{desde:30000,hasta:100000,tarifa:0.056} ] },
        { id:2, nombre:'Comercio, industria, servicios técnicos, telecomunicaciones', incConsumo:0, rangos:[
          {desde:0,hasta:6000,tarifa:0.016},{desde:6000,hasta:15000,tarifa:0.020},{desde:15000,hasta:30000,tarifa:0.035},{desde:30000,hasta:100000,tarifa:0.045} ] },
        { id:3, nombre:'Comidas y bebidas, transporte', incConsumo:0.08, rangos:[
          {desde:0,hasta:6000,tarifa:0.031},{desde:6000,hasta:15000,tarifa:0.034},{desde:15000,hasta:30000,tarifa:0.040},{desde:30000,hasta:100000,tarifa:0.045} ] },
        { id:4, nombre:'Servicios profesionales, consultoría, profesiones liberales', incConsumo:0, rangos:[
          {desde:0,hasta:6000,tarifa:0.059},{desde:6000,hasta:15000,tarifa:0.073},{desde:15000,hasta:30000,tarifa:0.12},{desde:30000,hasta:100000,tarifa:0.145} ] }
      ]
    },
    ica: {                                                   // POR MUNICIPIO — agregar los que apliquen
      medellin: { nombre:'Medellín', tarifasPorMil:{ servicios:7, comercio:5, industria:5 }, periodicidad:'anual' }
    },
    sas: {                                                   // Simulador SAS (persona jurídica) 2026
      tarifaRenta: 0.35,                                     // renta persona jurídica (art. 240)
      dividendoExentoUVT: 1090,                              // dividendos hasta 1.090 UVT no tienen retención (art. 242)
      dividendoTarifa: 0.15,                                 // sobre el exceso, 15% (aprox. del impuesto a dividendos ya con descuento art. 254-1)
      costoAnualTipico: 6000000,                             // contador + cámara + factura electrónica + firma (estimado editable)
      smmlv: 1423500,                                        // SMMLV 2025 (base para topes de revisor fiscal 2026)
      revisorFiscalIngresosSMMLV: 3000,                      // revisor fiscal obligatorio si ingresos ≥ 3.000 SMMLV
      revisorFiscalActivosSMMLV: 5000                        // o si activos ≥ 5.000 SMMLV
    },
    calendario: {                                            // Plazos DIAN 2026 (Decreto 2229/2023 · Comunicado DIAN 090)
      anio:2026,
      // Declaración de renta personas naturales AG 2025: por los DOS últimos dígitos de la cédula/NIT. Índice 0 = dígitos 01-02.
      rentaPN:[
        '2026-08-12','2026-08-13','2026-08-14','2026-08-18','2026-08-19','2026-08-20','2026-08-21','2026-08-24','2026-08-25','2026-08-26',
        '2026-08-27','2026-08-28','2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-07','2026-09-08','2026-09-09',
        '2026-09-10','2026-09-11','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21','2026-09-22','2026-09-23',
        '2026-09-24','2026-09-25','2026-09-28','2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09',
        '2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-26'
      ],
      exogenaVentana:'mayo–junio 2026'   // Res. DIAN 000227/2025; fecha exacta por los 2 últimos dígitos del NIT
    }
  };
  let FISCAL = FISCAL_DEFAULT;

  /* Carga el config fiscal del año desde Firestore, con caché en localStorage y respaldo embebido. */
  async function cargarConfigFiscal(anio){
    anio = anio || new Date().getFullYear();
    const cacheKey = 'abba_fiscal_' + anio;
    if(!firestoreAvailable){
      const c = localStorage.getItem(cacheKey);
      FISCAL = c ? JSON.parse(c) : FISCAL_DEFAULT;
      return FISCAL;
    }
    try{
      const doc = await db.collection('config').doc('fiscal').collection('anios').doc(String(anio)).get();
      if(doc.exists){
        FISCAL = doc.data();
        localStorage.setItem(cacheKey, JSON.stringify(FISCAL));
      } else {
        // No hay config del año: usar caché del año (o del anterior) o el respaldo, y marcar "sin verificar"
        const prev = localStorage.getItem(cacheKey) || localStorage.getItem('abba_fiscal_' + (anio-1));
        FISCAL = prev ? JSON.parse(prev) : FISCAL_DEFAULT;
        FISCAL = { ...FISCAL, _sinVerificar:true };
        console.warn('config/fiscal/anios/' + anio + ' no existe. Usando respaldo fiscal.');
      }
    }catch(e){
      const c = localStorage.getItem(cacheKey);
      FISCAL = c ? JSON.parse(c) : FISCAL_DEFAULT;
    }
    return FISCAL;
  }

  /* Helpers de acceso al config fiscal (úsalos en todo el motor de cálculo) */
  function uvtValor(){ return (FISCAL && FISCAL.uvt) || FISCAL_DEFAULT.uvt; }   // UVT en pesos del año vigente
  function enPesos(uvts){ return Math.round((uvts||0) * uvtValor()); }          // convierte UVT → pesos
  function fiscalConfig(){ return FISCAL; }                                     // acceso al objeto completo

  /* ═══════════════════════════════════════════════════════════
     PRESUPUESTO MENSUAL · API (Fase A)
     Base de datos por mes que alimenta la precisión fiscal y (en modo activo) el presupuesto.
     Usa las mismas categorías de gasto del Módulo 1 como rubros.
     ═══════════════════════════════════════════════════════════ */
  function pgState(){ if(!state.presupuesto) state.presupuesto={modo:'basico',anioGravable:2026,mesActivo:'2026-01',arrastre:true,gastos:{},ingresos:{},seeded:false}; return state.presupuesto; }
  var pgOpenMovs = {};   // UI transitoria: qué desgloses de movimientos están abiertos (no se persiste)
  function pgMovOpen(scope){ return !!pgOpenMovs[scope]; }
  function pgToggleMov(scope){ if(pgOpenMovs[scope]) delete pgOpenMovs[scope]; else pgOpenMovs[scope]=true; }
  var pgOpenMeta = {};   // UI transitoria: qué paneles de configuración de meta están abiertos
  function pgMetaOpen(k){ return !!pgOpenMeta[k]; }
  function pgToggleMeta(k){ if(pgOpenMeta[k]) delete pgOpenMeta[k]; else pgOpenMeta[k]=true; }
  function pgAnio(){ return pgState().anioGravable || new Date().getFullYear(); }
  function pgModo(){ return pgState().modo || 'basico'; }
  function pgMesKey(anio, m){ return anio + '-' + String(m).padStart(2,'0'); }   // m: 1..12
  function pgMeses(anio){ anio = anio || pgAnio(); const a=[]; for(let m=1;m<=12;m++) a.push(pgMesKey(anio,m)); return a; }
  function pgMesActivo(){ const p=pgState(); if(!p.mesActivo || p.mesActivo.slice(0,4)!=String(p.anioGravable)){ const h=pgHoy(); p.mesActivo = (h.slice(0,4)==String(p.anioGravable)) ? h : pgMesKey(pgAnio(),1); } return p.mesActivo; }
  function pgSetMes(mesKey){ pgState().mesActivo = mesKey; }
  function pgNombreMes(mesKey){ const M=['','enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']; return M[+mesKey.slice(5,7)]||''; }
  // Mes de HOY y clasificación (pasado / actual / futuro) respecto a un mes del año gravable.
  function pgHoy(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
  function pgHoyISO(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function pgFechaCorta(iso){ if(!iso) return ''; const p=String(iso).split('-'); if(p.length<3) return ''; const M=['','ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']; return (+p[2])+' '+(M[+p[1]]||''); }
  function pgClaseMes(mesKey){ const h=pgHoy(); return mesKey<h ? 'pasado' : (mesKey===h ? 'actual' : 'futuro'); }
  function pgMesInicio(){ const p=pgState(); if(!p.mesInicio) p.mesInicio = pgHoy(); return p.mesInicio; }
  // Categorías del Módulo 1 (rubros) con sus ÍTEMS dentro, en el orden persistente del Módulo 1.
  function pgGenId(){ const p=pgState(); p._iseq=(p._iseq||0)+1; return 'x'+Date.now().toString(36)+p._iseq; }
  // Estructura PROPIA del presupuesto (independiente del Módulo 1). Se siembra una vez desde el Módulo 1.
  function pgSeedEstructura(){
    const p=pgState();
    if(p.cats && p.cats.length) return;
    let order; try{ order=(typeof gastoCatOrder==='function')?gastoCatOrder():Object.keys(state.gastos||{}); }catch(e){ order=Object.keys(state.gastos||{}); }
    const L=state.gastosLabels||{};
    p.cats = order.map(catKey=>({
      id: pgGenId(),
      label: L[catKey] || (catKey.charAt(0).toUpperCase()+catKey.slice(1)),
      items: ((state.gastosItems && state.gastosItems[catKey]) || []).map(it=>({ id:pgGenId(), nombre:(it && it.nombre)||'', montoTipico:+((it&&it.monto)||0) }))
    }));
    p.estructuraSeeded = true;
  }
  function pgCategorias(){ const p=pgState(); if(!p.cats || !p.cats.length) pgSeedEstructura(); return p.cats || []; }
  function pgItemKey(catId, itemId){ return catId + '#' + itemId; }
  function pgSplitKey(itemKey){ const i=itemKey.indexOf('#'); return [itemKey.slice(0,i), itemKey.slice(i+1)]; }
  function pgFindCat(catId){ return pgCategorias().find(c=>c.id===catId); }
  function pgFindItem(itemKey){ const [cid,iid]=pgSplitKey(itemKey); const c=pgFindCat(cid); return c ? (c.items.find(x=>x.id===iid)||null) : null; }
  function pgItemNombre(it, idx){ return (it && it.nombre && it.nombre.trim()) ? it.nombre : ('Gasto '+(idx+1)); }
  function pgGeneralItem(itemKey){ const it=pgFindItem(itemKey); return it ? (+it.montoTipico||0) : 0; }
  function pgItemsFlat(){ const out=[]; pgCategorias().forEach(c=>{ (c.items||[]).forEach((it,idx)=>out.push({ itemKey:pgItemKey(c.id,it.id), catId:c.id, nombre:pgItemNombre(it,idx), montoTipico:+it.montoTipico||0 })); }); return out; }
  // CRUD + reordenamiento de la estructura del presupuesto.
  function pgAddCat(){ pgCategorias().push({ id:pgGenId(), label:'Nueva categoría', items:[] }); }
  function pgAddItem(catId){ const c=pgFindCat(catId); if(c) c.items.push({ id:pgGenId(), nombre:'', montoTipico:0 }); }
  function pgRenameCat(catId, label){ const c=pgFindCat(catId); if(c) c.label=label; }
  function pgRenameItem(itemKey, nombre){ const it=pgFindItem(itemKey); if(it) it.nombre=nombre; }
  function pgDelCat(catId){ const p=pgState(); p.cats=(p.cats||[]).filter(c=>c.id!==catId); }
  function pgDelItem(itemKey){ const [cid,iid]=pgSplitKey(itemKey); const c=pgFindCat(cid); if(c) c.items=c.items.filter(x=>x.id!==iid); }
  function pgMoveCat(fromIdx, toIdx){ const a=pgCategorias(); if(fromIdx<0||toIdx<0||fromIdx>=a.length||toIdx>=a.length) return; const [m]=a.splice(fromIdx,1); a.splice(toIdx,0,m); }
  function pgMoveItem(catId, fromIdx, toIdx){ const c=pgFindCat(catId); if(!c) return; const a=c.items; if(fromIdx<0||toIdx<0||fromIdx>=a.length||toIdx>=a.length) return; const [m]=a.splice(fromIdx,1); a.splice(toIdx,0,m); }
  function pgImportarDeModulo1(){ const p=pgState(); p.cats=[]; pgSeedEstructura(); }
  // Celda asignado/real por ÍTEM × mes. real=null => no registrado (para lo fiscal se estima con la cifra del Módulo 1).
  function pgCell(itemKey, mesKey){ const p=pgState(); p.gastos[itemKey]=p.gastos[itemKey]||{}; if(!p.gastos[itemKey][mesKey]) p.gastos[itemKey][mesKey]={meta:null,real:null}; return p.gastos[itemKey][mesKey]; }
  function pgAsignadoRaw(itemKey, mesKey){ const m=pgCell(itemKey,mesKey).meta; return (typeof m==='number')?m:null; }   // explícito o null
  // Asignado EFECTIVO: si no se fijó explícito este mes, se TRAE del último mes anterior que sí lo tenga (arrastre de asignación).
  function pgAsignado(itemKey, mesKey){
    const raw=pgAsignadoRaw(itemKey,mesKey); if(raw!==null) return raw;
    // Mes activo sin ingreso registrado: no se hereda (no repartes plata que aún no ha entrado). Al registrar ingreso, vuelve a heredar.
    if(pgClaseMes(mesKey)==='actual' && !pgIngresoRegistrado(mesKey)) return 0;
    let y=+mesKey.slice(0,4), m=+mesKey.slice(5,7);
    for(let i=0;i<24;i++){ m--; if(m<1){ m=12; y--; } const pk=y+'-'+String(m).padStart(2,'0'); const pr=pgAsignadoRaw(itemKey,pk); if(pr!==null) return pr; }
    return 0;
  }
  function pgAsignadoHeredado(itemKey, mesKey){ return pgAsignadoRaw(itemKey,mesKey)===null && pgAsignado(itemKey,mesKey)>0; }   // ¿se trae del mes anterior?
  function pgSetAsignado(itemKey, mesKey, v){ pgCell(itemKey,mesKey).meta = Math.max(0,+v||0); }
  function pgRealRaw(itemKey, mesKey){ const r=pgCell(itemKey,mesKey).real; return (typeof r==='number')?r:null; }
  function pgSetReal(itemKey, mesKey, v){ pgCell(itemKey,mesKey).real = (v===null||v==='')?null:Math.max(0,+v||0); }
  // MOVIMIENTOS de gasto: desglose de lo gastado en transacciones. Si hay movimientos, el gastado del mes = su suma.
  function pgMovs(itemKey, mesKey){ const c=pgCell(itemKey,mesKey); if(!Array.isArray(c.movs)) c.movs=[]; return c.movs; }
  function pgMovsTotal(itemKey, mesKey){ return pgMovs(itemKey,mesKey).reduce((s,m)=>s+(+m.monto||0),0); }
  function pgHasMovs(itemKey, mesKey){ return pgMovs(itemKey,mesKey).length>0; }
  function pgAddMov(itemKey, mesKey, monto, nota, fecha){ pgMovs(itemKey,mesKey).push({id:pgGenId(), monto:Math.max(0,+monto||0), nota:(nota||'').trim(), fecha:fecha||pgHoyISO()}); }
  function pgDelMov(itemKey, mesKey, movId){ const c=pgCell(itemKey,mesKey); c.movs=(c.movs||[]).filter(m=>m.id!==movId); }
  function pgSetMovMonto(itemKey, mesKey, movId, v){ const m=pgMovs(itemKey,mesKey).find(x=>x.id===movId); if(m) m.monto=Math.max(0,+v||0); }
  function pgSetMovNota(itemKey, mesKey, movId, v){ const m=pgMovs(itemKey,mesKey).find(x=>x.id===movId); if(m) m.nota=(v||'').trim(); }
  function pgSetMovFecha(itemKey, mesKey, movId, v){ const m=pgMovs(itemKey,mesKey).find(x=>x.id===movId); if(m) m.fecha=v||pgHoyISO(); }
  function pgRegistrado(itemKey, mesKey){ return pgHasMovs(itemKey,mesKey); }
  function pgGastadoMes(itemKey, mesKey){ return pgHasMovs(itemKey,mesKey) ? pgMovsTotal(itemKey,mesKey) : 0; }   // solo por movimientos
  function pgGastoFiscalMes(itemKey, mesKey){ return pgHasMovs(itemKey,mesKey) ? pgMovsTotal(itemKey,mesKey) : pgGeneralItem(itemKey); }   // real (movimientos) o estimado del M1 para flujo
  // Sobrante disponible con ARRASTRE (R1): acumula (asignado + arrastre previo − gastado) mes a mes.
  function pgDisponible(itemKey, mesKey){
    const p=pgState(); const meses=pgMeses(mesKey.slice(0,4)); let saldo=0;
    for(const mk of meses){ saldo += pgAsignado(itemKey,mk) - pgGastadoMes(itemKey,mk); if(mk===mesKey) break; if(!p.arrastre) saldo = 0; }
    return saldo;
  }
  // ── FASE C · Tipos de meta por rubro ────────────────────────────────────
  // tipo: 'mensual' (fija cada mes) · 'fecha' (llegar a un objetivo para una fecha) · 'llenar' (aportar hasta un tope)
  function pgItemMeta(it){ if(!it) return {tipo:'mensual'}; if(!it.meta || typeof it.meta!=='object') it.meta={tipo:'mensual'}; if(!it.meta.tipo) it.meta.tipo='mensual'; return it.meta; }
  function pgMesSig(mesKey){ let y=+mesKey.slice(0,4), m=+mesKey.slice(5,7); m++; if(m>12){m=1;y++;} return pgMesKey(y,m); }
  function pgMesPrev(mesKey){ let y=+mesKey.slice(0,4), m=+mesKey.slice(5,7); m--; if(m<1){m=12;y--;} return pgMesKey(y,m); }
  function pgMesesRestantes(desde, hasta){ const y1=+desde.slice(0,4),m1=+desde.slice(5,7),y2=+hasta.slice(0,4),m2=+hasta.slice(5,7); return Math.max(1,(y2-y1)*12+(m2-m1)+1); }
  // Ahorrado hacia la meta ANTES de este mes (disponible acumulado del mes anterior, dentro del año).
  function pgMetaAcumPrev(itemKey, mesKey){ if(+mesKey.slice(5,7)<=1) return 0; return Math.max(0, pgDisponible(itemKey, pgMesPrev(mesKey))); }
  // INTEGRACIÓN con el módulo de Metas: la meta 'fecha' del presupuesto referencia una meta real (objetivo, fecha y saldo viven allá).
  function pgMetasList(){ if(!state.metas) return []; try{ metaEnsureIds(); }catch(e){} return state.metas.items||[]; }
  function pgMetaVinculada(it){ const meta=pgItemMeta(it); if(meta.tipo!=='fecha' || !meta.metaRef) return null; return pgMetasList().find(m=>m.id===meta.metaRef)||null; }
  function pgMetaSaldoReal(v){ try{ return metaSaldoActual(v)||0; }catch(e){ return 0; } }
  // Aporte mensual igual = (objetivo − saldo real) / meses que faltan hasta la fecha de la meta.
  function pgMetaAportePorMes(it){
    const v=pgMetaVinculada(it); if(!v || !v.fecha || !(+v.objetivo>0)) return 0;
    const anio=pgAnio(); const inicio=(pgMesActivo().slice(0,4)===String(anio))?pgMesActivo():pgMesKey(anio,1);
    const falta=Math.max(0, (+v.objetivo) - pgMetaSaldoReal(v));
    if(v.fecha < inicio) return falta;                         // la fecha ya pasó → lo que falte, de una
    return Math.round(falta / pgMesesRestantes(inicio, v.fecha));
  }
  // Escribe el aporte en cada mes desde el mes activo hasta la fecha de la meta (y 0 después, dentro del año).
  function pgDistribuirMetaFecha(itemKey, it){
    const v=pgMetaVinculada(it); if(!v || !v.fecha || !(+v.objetivo>0)) return;
    const anio=pgAnio(); const inicio=(pgMesActivo().slice(0,4)===String(anio))?pgMesActivo():pgMesKey(anio,1);
    const per=pgMetaAportePorMes(it);
    let mk=inicio, guard=0;
    while(guard<48){
      if(mk.slice(0,4)===String(anio)){
        if(mk>=inicio && mk<=v.fecha) pgSetAsignado(itemKey,mk,per);
        else if(mk>v.fecha) pgSetAsignado(itemKey,mk,0);
      }
      if(mk===pgMesKey(anio,12)) break;
      mk=pgMesSig(mk); guard++;
    }
  }
  // Cupo que falta para el tope en una meta 'llenar'.
  function pgMetaRoom(itemKey, it, mesKey){ const meta=pgItemMeta(it); if(meta.tipo!=='llenar' || !(+meta.tope>0)) return null; return Math.max(0, (+meta.tope) - pgMetaAcumPrev(itemKey, mesKey)); }
  // Ingreso por mes. meta = esperado; real = registrado (null si no).
  function pgIngresoCell(mesKey){ const p=pgState(); if(!p.ingresos[mesKey]) p.ingresos[mesKey]={meta:0,real:null}; return p.ingresos[mesKey]; }
  function pgIngresoMensualGeneral(){ try{ return (state.ingresos||[]).reduce((s,i)=>s+(+i.monto||0),0); }catch(e){ return 0; } }
  function pgIngresoRealRaw(mesKey){ const r=pgIngresoCell(mesKey).real; return (typeof r==='number')?r:null; }
  function pgSetIngresoReal(mesKey, v){ pgIngresoCell(mesKey).real = (v===null||v==='')?null:Math.max(0,+v||0); }
  // MOVIMIENTOS de ingreso: si hay movimientos, el ingreso del mes = su suma.
  function pgIngMovs(mesKey){ const c=pgIngresoCell(mesKey); if(!Array.isArray(c.movs)) c.movs=[]; return c.movs; }
  function pgIngMovsTotal(mesKey){ return pgIngMovs(mesKey).reduce((s,m)=>s+(+m.monto||0),0); }
  function pgIngHasMovs(mesKey){ return pgIngMovs(mesKey).length>0; }
  function pgAddIngMov(mesKey, monto, nota, fecha){ pgIngMovs(mesKey).push({id:pgGenId(), monto:Math.max(0,+monto||0), nota:(nota||'').trim(), fecha:fecha||pgHoyISO()}); }
  function pgDelIngMov(mesKey, movId){ const c=pgIngresoCell(mesKey); c.movs=(c.movs||[]).filter(m=>m.id!==movId); }
  function pgSetIngMovMonto(mesKey, movId, v){ const m=pgIngMovs(mesKey).find(x=>x.id===movId); if(m) m.monto=Math.max(0,+v||0); }
  function pgSetIngMovNota(mesKey, movId, v){ const m=pgIngMovs(mesKey).find(x=>x.id===movId); if(m) m.nota=(v||'').trim(); }
  function pgSetIngMovFecha(mesKey, movId, v){ const m=pgIngMovs(mesKey).find(x=>x.id===movId); if(m) m.fecha=v||pgHoyISO(); }
  function pgIngresoRegistrado(mesKey){ return pgIngHasMovs(mesKey) || pgIngresoRealRaw(mesKey)!==null; }
  function pgIngresoPlan(mesKey){ if(pgIngHasMovs(mesKey)) return pgIngMovsTotal(mesKey); const r=pgIngresoRealRaw(mesKey); return r!==null?r:(pgIngresoCell(mesKey).meta||0); }        // para asignar
  function pgIngresoFiscalMes(mesKey){ if(pgIngHasMovs(mesKey)) return pgIngMovsTotal(mesKey); const r=pgIngresoRealRaw(mesKey); return r!==null?r:pgIngresoMensualGeneral(); }        // para lo fiscal
  // PREFILL OPCIONAL (no automático): siembra lo asignado de cada ítem con su cifra del Módulo 1, solo meses actual/futuros.
  function pgPrefill(anio){
    anio = anio || pgAnio(); const p=pgState(); const meses=pgMeses(anio); pgMesInicio();
    pgItemsFlat().forEach(it=>{ meses.forEach(mk=>{ if(pgClaseMes(mk)==='pasado') return; const c=pgCell(it.itemKey,mk); if(!(c.meta>0)) c.meta = it.montoTipico; }); });
    p.prefilled = true;
  }
  // Totales del mes.
  function pgTotAsignado(mesKey){ return pgItemsFlat().reduce((s,it)=>s+pgAsignado(it.itemKey,mesKey),0); }
  function pgTotGastadoMes(mesKey){ return pgItemsFlat().reduce((s,it)=>s+pgGastadoMes(it.itemKey,mesKey),0); }
  function pgTotFiscalGasto(mesKey){ return pgItemsFlat().reduce((s,it)=>s+pgGastoFiscalMes(it.itemKey,mesKey),0); }
  function pgListoParaAsignar(mesKey){ return pgIngresoPlan(mesKey) - pgTotAsignado(mesKey); }
  // Totales por categoría (para el encabezado de grupo).
  function pgCatAsignado(catKey, items, mesKey){ return items.reduce((s,it)=>s+pgAsignado(pgItemKey(catKey,it.id),mesKey),0); }
  function pgCatGastado(catKey, items, mesKey){ return items.reduce((s,it)=>s+pgGastadoMes(pgItemKey(catKey,it.id),mesKey),0); }
  function pgCatDisponible(catKey, items, mesKey){ return items.reduce((s,it)=>s+pgDisponible(pgItemKey(catKey,it.id),mesKey),0); }

  /* Sembrado ÚNICO del config fiscal en Firestore. Ejecutar una sola vez desde la consola
     del navegador (estando dentro de la app):  sembrarConfigFiscal(2026)
     Crea el documento config/fiscal/anios/{año} con los valores de respaldo, listos para editar. */
  async function sembrarConfigFiscal(anio){
    anio = anio || new Date().getFullYear();
    if(!firestoreAvailable){ console.warn('Firestore no disponible (modo localStorage).'); return false; }
    if(!confirm('¿Crear/sobrescribir el config fiscal '+anio+' en Firestore con los valores de respaldo?')) return false;
    const seed = JSON.parse(JSON.stringify(FISCAL_DEFAULT));
    if(seed.vigencia){ delete seed.vigencia._respaldo; seed.vigencia.anio = anio; seed.vigencia.fuente += ' · sembrado inicial, validar con DIAN/municipio'; }
    try{
      await db.collection('config').doc('fiscal').collection('anios').doc(String(anio)).set(seed, {merge:false});
      console.log('%c✓ Config fiscal '+anio+' creado en Firestore. Edítalo en: config → fiscal → anios → '+anio, 'color:#0e4d3a;font-weight:bold');
      return true;
    }catch(e){ console.error('No se pudo crear el config fiscal:', e); return false; }
  }
  if(typeof window!=='undefined') window.sembrarConfigFiscal = sembrarConfigFiscal;
  
  /* AuthService — abstrae los métodos de auth para que el resto de la app no dependa de Firebase directamente */
  const authService = {
    /* Suscribirse a cambios de estado de autenticación. Callback recibe (user|null) */
    onChange(callback){
      if(!authAvailable){
        // Modo localStorage: leer un usuario falso si existe
        const stored = localStorage.getItem('abba_local_user');
        callback(stored ? JSON.parse(stored) : null);
        return ()=>{};
      }
      return auth.onAuthStateChanged(callback);
    },
  
    async loginEmail(email, password){
      if(!authAvailable){
        // Modo localStorage: aceptar cualquier credencial sin validar (solo dev/demo)
        const fakeUser = {uid:'local_'+btoa(email).slice(0,16), email:email, displayName:email.split('@')[0]};
        localStorage.setItem('abba_local_user', JSON.stringify(fakeUser));
        return fakeUser;
      }
      const cred = await auth.signInWithEmailAndPassword(email, password);
      return cred.user;
    },
  
    async registerEmail(email, password){
      if(!authAvailable){
        const fakeUser = {uid:'local_'+btoa(email).slice(0,16), email:email, displayName:email.split('@')[0]};
        localStorage.setItem('abba_local_user', JSON.stringify(fakeUser));
        return fakeUser;
      }
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      return cred.user;
    },
  
    async loginGoogle(){
      if(!authAvailable){
        const fakeUser = {uid:'local_google', email:'demo@gmail.com', displayName:'Usuario Google'};
        localStorage.setItem('abba_local_user', JSON.stringify(fakeUser));
        return fakeUser;
      }
      const provider = new firebase.auth.GoogleAuthProvider();
      const cred = await auth.signInWithPopup(provider);
      return cred.user;
    },
  
    async sendPasswordReset(email){
      if(!authAvailable){
        // En modo local no enviamos correo; simulamos éxito
        return true;
      }
      await auth.sendPasswordResetEmail(email);
      return true;
    },
  
    async logout(){
      if(!authAvailable){
        localStorage.removeItem('abba_local_user');
        return;
      }
      await auth.signOut();
    },
  
    /* Devuelve el usuario actual (sincrónico) */
    current(){
      if(!authAvailable){
        const stored = localStorage.getItem('abba_local_user');
        return stored ? JSON.parse(stored) : null;
      }
      return auth.currentUser;
    },
  
    /* Traduce los códigos de error de Firebase a mensajes legibles en español */
    prettyError(err){
      const code = err && err.code ? err.code : '';
      const map = {
        'auth/invalid-email':'El correo no tiene un formato válido.',
        'auth/user-not-found':'No encontramos una cuenta con ese correo.',
        'auth/wrong-password':'La contraseña es incorrecta.',
        'auth/invalid-credential':'Correo o contraseña incorrectos.',
        'auth/email-already-in-use':'Ya existe una cuenta con ese correo. Intenta iniciar sesión.',
        'auth/weak-password':'La contraseña debe tener al menos 6 caracteres.',
        'auth/network-request-failed':'Sin conexión a internet. Revisa tu red.',
        'auth/too-many-requests':'Demasiados intentos. Espera unos minutos.',
        'auth/popup-closed-by-user':'Cerraste la ventana de Google sin completar el inicio.',
        'auth/popup-blocked':'Tu navegador bloqueó la ventana emergente. Permítela e intenta de nuevo.'
      };
      return map[code] || (err && err.message) || 'Algo salió mal. Intenta de nuevo.';
    }
  };
  
  /* ═══════════════════════════════════════════════════════════
     STATE
     ═══════════════════════════════════════════════════════════ */
  let userId='', currency='COP $';
  let completedModules=new Set();
  
  const MODULE_TITLES = {
    1:'Ingresos y Gastos',2:'Endeudamiento',3:'Mapa Patrimonial',
    4:'Ahorro y Solvencia',5:'Gastos no periódicos',6:'Tablero de Control',
    7:'Simulador de Deuda',
    8:'Metas y Proyección',
    9:'Informe para mi Asesor',
    10:'Perfil fiscal',
    11:'Diagnóstico fiscal',
    12:'Presupuesto mensual',
    13:'Estructura Legal',
    14:'Planificación Sucesoral',
    15:'Evaluación 4 Capas',
    'var':'Ingresos Variables'
  };
  
  const MES_NAMES_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const MES_NAMES_FULL = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  
  const DEBT_TYPES = [
    {val:'CONSUMO_TARJETA',  label:'Consumo · Tarjeta de crédito',  group:'consumo'},
    {val:'CONSUMO_PRESTAMO', label:'Consumo · Préstamo personal',    group:'consumo'},
    {val:'CONSUMO_LIBRANZA', label:'Consumo · Libranza',             group:'consumo'},
    {val:'APAL_HIPOTECA',    label:'Apalancamiento · Hipotecaria',   group:'apalancamiento'},
    {val:'APAL_INVERSION',   label:'Apalancamiento · Inversión/Negocio', group:'apalancamiento'},
    {val:'OTRO_EDUCACION',   label:'Otro · Educación',               group:'otro'},
    {val:'OTRO_VEHICULO',    label:'Otro · Vehículo',                group:'otro'},
    {val:'OTRO_PERSONAL',    label:'Otro · Deuda personal/familiar', group:'otro'}
  ];
  
  const state = {
    ingresos:[
      {nombre:'Salario',monto:0},{nombre:'Ventas',monto:0},
      {nombre:'Otra fuente 02',monto:0},{nombre:'Otra fuente 03',monto:0}
    ],
    gastos:{alimentacion:0,vivienda:0,transporte:0,salud:0,entretenimiento:0,comunicaciones:0,otros:0},
    gastosItems:{},   // por categoría: [{nombre,monto}]; el total de la categoría = suma de sus items
    gastosLabels:{},
    gastosOrder:['alimentacion','vivienda','transporte','salud','entretenimiento','comunicaciones','otros'], // orden persistente de categorías (los objetos no conservan orden en Firestore)
    deudas:[],
    fiscal:{
      regimen:'',                       // 'ord' | 'simple' | ''
      resp:{ iva:false, retencion:false, ica:false, exogena:false },
      ciiu:'', municipios:'',
      digitosCedula:'', digitosNit:'',
      consumosTarjeta:0, comprasConsumos:0, consignaciones:0,
      exterior:{ tiene:false, valor:0, ingresos:0 },
      iva:{ ventasGravadas:0, comprasConIva:0 },
      segSocial:{ salud:0, pension:0 },
      interesesVivienda:0,                // deducción intereses crédito de vivienda (tope 1.200 UVT)
      retencion:0,                        // retención en la fuente ya practicada en el año
      aporteVoluntario:0,                 // aportes voluntarios FPV/AFC en el año (renta exenta, tope 30% / 3.800 UVT)
      gmf:0,                              // 4x1000 (GMF) pagado en el año; deducible el 50% (art. 115)
      simpleGrupo:4,                      // grupo del Régimen Simple para el comparador (4 = servicios profesionales)
      simpleCheck:{},                      // respuestas de elegibilidad Simple: {residente,actividad,realidad,aldia,factura,socio}
      sas:{ costosNegocio:0, salario:0, costosAnuales:null, repartoPct:100 },   // simulador SAS (costosAnuales null = usa el típico de config)
      herencia:{ vivienda:0, otrosInmuebles:0, otrosBienes:0, seguroVida:0, numHerederos:1, esLegitimario:true },   // calculador de ganancia ocasional por herencia
      patrimonio:{ viviendaHabitacion:0 },   // valor de la vivienda de habitación (para la exclusión del impuesto al patrimonio)
      ingresosExcluidos:{},               // { claveLinea: true } → ingresos que ya vienen de un activo (no contar)
      costoFiscal:{},                    // { [assetId]: {metodo,anioCompra,valorCompra,avaluo,costoFiscal} }
      legal:{                             // Módulo 13 · Estructura Legal Patrimonial
        estadoCivil:'', regimenConyugal:'', anioMatrimonioUnion:'',
        hijosMenores:0, hijosMayoresDependientes:0, otrosDependientes:0,
        gastoMensualFamilia:0,             // Cuánto necesita la familia al mes si tú faltas
        testamento:{ tiene:null, tipo:'', anioOtorgamiento:'', revisadoTrasCambios:null },
        poderes:{ generalAdmin:false, directivaAnticipada:false },
        segurosVida:[],
        avalesTerceros:{ tiene:null, monto:0, detalle:'' },
        pleitosVigentes:{ tieneComoDemandado:null, montoPretensiones:0, detalle:'' },
        cumplimientoExterior:{ formulario160Presentado:null, tieneVehiculoECE:false, detalleECE:'' },
        coberturas:{
          rcProfesional:{ tiene:null, sumaAsegurada:0 },
          dyo:{ tiene:null, quienContrata:'' }
        },
        planSucesoral:{                    // Checklist persistente de acciones a completar
          acciones:{}                      // { 'testamento': true, 'seguro_vida': false, ... }
        }
      }
    },
    activos:[
      {nombre:'Dinero ahorrado en cuenta',valor:0,tipo:'LÍQUIDO'},
      {nombre:'Cuentas por cobrar',valor:0,tipo:'LÍQUIDO'},
      {nombre:'Inversión de corto plazo',valor:0,tipo:'LÍQUIDO'},
      {nombre:'Vehículo',valor:0,tipo:'NO LÍQUIDO'},
      {nombre:'Apartamento / Casa',valor:0,tipo:'NO LÍQUIDO'},
      {nombre:'Inversión de largo plazo',valor:0,tipo:'NO LÍQUIDO'}
    ],
    ahorro:[
      {nombre:'Fondo de Emergencias',monto:0},{nombre:'Viaje',monto:0},
      {nombre:'Retiro',monto:0},{nombre:'Inversión',monto:0}
    ],
    p5:{socio1:'',socio2:'',ingresos:[],deudas:[],ahorro:[],gastos:{},gastoCats:[],
        ingMensual:0,ingAnual:0,deuMensual:0,deuAnual:0,
        ahoMensual:0,ahoAnual:0,gastosMensual:0,gastosAnual:0,saldo:0,
        fondoProvisiones:0},
    cuposDisponibles:0,   // cupos de crédito/tarjetas sin usar: respaldo de emergencia (con costo)
    tablero:{
      meta_ingresos:0,meta_ahorro:0,meta_deudas:0,meta_gastos:0,
      meta_otros_ingresos:0,meta_otro_ahorro:0,meta_otros_deudas:0,meta_otros_gastos:0,
      meta_consumo:0,meta_deuda_total:0,meta_pct_liquidos:0,meta_pct_noliquidos:0,
      meta_fondo_emerg:0,meta_solvencia:0,meta_ratio_consumo:0,meta_ratio_apal:0,
      objetivos:Array(15).fill(''),plan:'',
      planDeuda:{activo:false, extraMensual:0, abono:{monto:0, mes:1, fuente:'ingreso'}},
      budgetRule:{rule:'50/30/20', custom:{nec:50,des:30,aho:20}, buckets:{}},
      couple:{ingreso1:null, ingreso2:null, compartido:null, modo:'proporcional'}
    },
    varIncome:{
      active:false,
      contratos:[],   // cada uno: {id,nombre,tipo,retencionAplica,retencionPct,meses:[]}
      fondoActual:0,
      salarioPersonal:0,
      salarioOverride:false
    },
    profile:{
      tipoIngreso:'', // 'empleado' | 'independiente' | 'mixto' | ''
      uid:'', edad:null, dependientes:null, edadRetiro:null
    },
    debtSim:{
      seeded:false,
      customized:false,        // true si el usuario editó la lista de deudas del simulador
      capacidadExtra:0,
      estrategia:'avalancha',   // orden: 'avalancha' | 'bola_nieve' | 'personalizada'
      consolidacionActiva:false,// capa de compra de cartera (independiente del orden)
      consolidacionTasa:18,     // % E.A.
      consolidacionPlazo:36,    // meses
      ordenPersonalizado:[],    // orden personalizado por id de deuda (incluye el crédito consolidado)
      ocultarPlanTablero:false, // ocultar "Tu plan de pago de deudas" en el Tablero
      abonoMonto:0,
      abonoMes:1,               // en cuántos meses se recibe (1 = este mes)
      abonoFuente:'ingreso',    // fuente del abono extraordinario: 'ingreso' (prima nueva) | 'ahorro' (traslado)
      deudas:[]                 // [{id, nombre, saldo, tasa(decimal E.A.), pago, consolidar}]
    },
    metas:{
      seeded:false,
      items:[],                 // [{nombre, objetivo, fecha(YYYY-MM), fuente, saldoManual, aporte}]
      proy:{ rendimiento:9, anios:28, inicialOverride:null, aporteOverride:null, aniosUserSet:false }
    },
    /* ── PRESUPUESTO MENSUAL (Fase A · base de datos por mes) ──
       modo 'basico'  = no presupuesta; los meses se rellenan solos con la cifra general (lo fiscal queda preciso sin esfuerzo).
       modo 'activo'  = presupuesta mes a mes con metas, real y arrastre de sobrantes.
       Usa los MISMOS rubros del Módulo 1 (categorías de gasto). Datos por categoría × mes (YYYY-MM). */
    presupuesto:{
      modo:'basico',
      anioGravable:2026,
      mesActivo:'2026-01',
      mesInicio:'',                  // mes en que se activó el presupuesto (se presupuesta desde aquí)
      arrastre:true,                 // arrastrar el sobrante de un mes al siguiente (R1)
      gastos:{},                     // { [itemKey]: { 'YYYY-MM': {meta, real} } }  (itemKey = catId#itemId)
      ingresos:{},                   // { 'YYYY-MM': {meta, real} }  (ingreso total del mes)
      cats:[],                       // estructura PROPIA del presupuesto (independiente del Módulo 1); se siembra una vez
      seeded:false
    }
  };

/* ═══════════════════════════════════════════════════════════
   MÓDULO 3 · MAPA PATRIMONIAL (integrado)
   ═══════════════════════════════════════════════════════════ */
  // ════════════════════════════════════════════════════════════════════════════════
  // MÓDULO 3 · MAPA PATRIMONIAL  (integrado en la herramienta)
  // Estado propio `mp`; se conecta a la herramienta vía `host`.
  // La deuda NO se guarda en el activo: el activo guarda IDs de deudas del Módulo 2.
  // ════════════════════════════════════════════════════════════════════════════════
  const MapaPatrimonial = (function(){

  // Estado interno del mapa (no colisiona con el `state` de la herramienta)
  const mp = {
    trm: {},
    assets: [],
    draft: null,
    editingId: null,
    currentStep: 1,
  };

  // ── Contrato con la herramienta (host) ──────────────────────────────────────────
  // Estas funciones las cablea la herramienta al inicializar el módulo.
  const host = {
    getDeudas: () => [],            // -> [{id,nombre,saldo,...}] del Módulo 2
    getDeudaById: (id) => null,     // -> {id,nombre,saldo,...} | null
    createDeuda: (info) => null,    // crea deuda en el M2, devuelve su id
    persist: () => {},              // guarda activos+trm del mapa en Firestore
    onChange: () => {},             // notifica a la herramienta que cambió el mapa
    confirm: (opts) => { if (window.confirm(opts.msg||'¿Confirmar?')) { if(opts.onConfirm) opts.onConfirm(); } },
    toast: (msg) => {},             // muestra un toast (lo provee la herramienta)
  };

  // ── Persistencia (delegada en la herramienta) ───────────────────────────────────
  function mpSave() {
    try { host.persist({ trm: mp.trm, activos: mp.assets }); } catch(e) { console.error(e); }
    emitChange();
  }

  // ── Función puente: lo que los módulos 4/6/8 saben leer, sin perder nada ─────────
  // Devuelve el detalle COMPLETO del mapa + un resumen normalizado para el resto de
  // la herramienta (activos con valor en COP y bandera de liquidez líquido/no líquido).
  const changeListeners = [];
  function emitChange() {
    const data = getExportData();
    changeListeners.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
    try { host.onChange(data); } catch(e) {}
    document.dispatchEvent(new CustomEvent('mapaActivos:change', { detail: data }));
  }

  // Liquidez del mapa -> clasificación líquido/no líquido que usa la herramienta.
  // 'Alta' y 'Media' se consideran líquido; 'Baja' e 'Ilíquida' no líquido.
  function liquidezToTipo(liquidez) {
    return (liquidez === 'Alta' || liquidez === 'Media') ? 'LÍQUIDO' : 'NO LÍQUIDO';
  }

  function getExportData() {
    // Resumen normalizado para M4/M6/M8: un activo por bien, valor BRUTO en COP.
    // (La deuda se cuenta aparte en el M2; aquí no se descuenta para no duplicar.)
    const activosNormalizados = mp.assets.map(a => {
      const v = valueCOP(a);
      const valCOP = isFinite(v) ? v : 0;
      // Factor para pasar de la moneda del activo a COP
      const factorCOP = (a.currency && a.currency !== 'COP') ? (mp.trm[a.currency] || 0) : 1;
      const valz = calcValorizacion(a);   // en moneda del activo
      const proy5 = calcProyeccion(a, 5);
      const proy10 = calcProyeccion(a, 10);
      const proy15 = calcProyeccion(a, 15);
      return {
        nombre: a.description || findSubtypeLabel(a.category, a.subtype) || a.category,
        valor: valCOP,
        tipo: liquidezToTipo(a.liquidity),
        restringido: !!a.restringidoLegal,
        _mapaId: a.id,
        _categoria: a.category,
        _subtipo: a.subtype,
        _liquidez: a.liquidity,
        _horizonte: horizonteLiquidez(a),
        _vigenciaCumplida: !!a.vigenciaCumplida,
        _reparto: a.reparto || '',
        _fpvInstitucional: !!a.fpvInstitucional,
        _fpvPermanencia: !!a.fpvPermanencia,
        _moneda: a.currency || 'COP',
        _pais: a.location || 'Colombia',
        _sector: a.sector || '',
        _ingresoMensual: a.monthlyIncome || 0,
        _destinoIngreso: a.incomeRendimientos || '',
        _beneficioTributario: !!a.beneficioTributario,
        _estructuraLegal: a.legalStructure || '',
        _esCompartido: !!a.esCompartido,
        _porcentajePropio: (a.porcentajePropio != null ? a.porcentajePropio : 100),
        _deudaCOP: linkedDebtCOP(a),
        _netoCOP: (isFinite(v) ? v : 0) - linkedDebtCOP(a),
        _esProductivo: esActivoProductivo(a),
        _comportamiento: comportamientoActivo(a),
        _admiteProyeccion: admiteProyeccion(a),
        // Valorización pasada (% anualizado real); ganancia en COP
        _valorizacionPct: valz ? valz.cagr : null,
        _gananciaCOP: valz ? valz.ganancia * factorCOP : null,
        // Proyección a futuro, ya en COP (futuro sin TRM se queda en moneda original * factor)
        _proyeccion5COP: proy5 ? proy5.futuro * factorCOP : null,
        _proyeccion10COP: proy10 ? proy10.futuro * factorCOP : null,
        _proyeccion15COP: proy15 ? proy15.futuro * factorCOP : null,
      };
    });
    return {
      _format: 'mapa-patrimonial-autoservicio',
      _version: 6,
      trm: mp.trm,
      activos: mp.assets,            // detalle COMPLETO e intacto
      activosNormalizados,           // resumen para el resto de la herramienta
      resumen: {
        cantidadBienes: mp.assets.length,
        patrimonioBrutoCOP: totalGrossAssets(),
        patrimonioNetoCOP: totalNetWorth(),
        deudaTotalCOP: totalDebt(),
        ingresoPasivoMensualCOP: mp.assets.reduce((s,a)=>{
          const im = a.monthlyIncome || 0;
          if (im <= 0) return s;
          // convertir a COP si el ingreso está en la moneda del activo
          const r = (a.currency && a.currency !== 'COP') ? (mp.trm[a.currency] || 0) : 1;
          return s + im * r;
        }, 0),
        // Patrimonio proyectado: cada activo aporta su proyección si la admite; si no, su valor de hoy.
        patrimonioProyectado: (() => {
          const horizonte = (anios) => activosNormalizados.reduce((s, a) => {
            const key = '_proyeccion' + anios + 'COP';
            const proy = a[key];
            return s + (proy != null && isFinite(proy) ? proy : a.valor);
          }, 0);
          return { a5: horizonte(5), a10: horizonte(10), a15: horizonte(15) };
        })(),
        // Cuántos activos admiten proyección honesta (para la nota del dashboard)
        activosProyectables: activosNormalizados.filter(a => a._admiteProyeccion).length,
        // Ganancia total acumulada en activos con datos de compra (valorización pasada)
        gananciaAcumuladaCOP: activosNormalizados.reduce((s, a) => s + (a._gananciaCOP != null ? a._gananciaCOP : 0), 0),
        // Ingreso pasivo proyectado: crece con el activo que lo genera (si ese activo admite proyección).
        ingresoPasivoProyectado: (() => {
          const calc = (anios) => mp.assets.reduce((s, a) => {
            const im = a.monthlyIncome || 0;
            if (im <= 0) return s;
            const r = (a.currency && a.currency !== 'COP') ? (mp.trm[a.currency] || 0) : 1;
            const baseCOP = im * r;
            // Si el activo que genera la renta crece (tasa/mercado), la renta crece igual; si no, se mantiene.
            const comp = comportamientoActivo(a);
            let factor = 1;
            if (comp === 'tasa' && (a.tasaRendimiento || 0) > 0) {
              factor = Math.pow(1 + a.tasaRendimiento, anios);
            } else if (comp === 'mercado') {
              const v = calcValorizacion(a);
              if (v) factor = Math.pow(1 + v.cagr, anios);
            }
            return s + baseCOP * factor;
          }, 0);
          return { a5: calc(5), a10: calc(10), a15: calc(15) };
        })(),
        // Concentración en un solo negocio (categoría Empresarial), para el bloque de negocio único.
        negocioUnico: (() => {
          const empresas = activosNormalizados.filter(a => a._categoria === 'Empresarial');
          if (!empresas.length) return null;
          let mayor = empresas[0];
          empresas.forEach(e => { if (e.valor > mayor.valor) mayor = e; });
          const bruto = totalGrossAssets();
          return {
            cantidad: empresas.length,
            mayorNombre: mayor.nombre,
            mayorValor: mayor.valor,
            mayorPct: bruto > 0 ? (mayor.valor / bruto * 100) : 0,
            totalEmpresarialPct: bruto > 0 ? (empresas.reduce((s,e)=>s+e.valor,0) / bruto * 100) : 0,
          };
        })(),
        pendientesConversion: mp.assets.filter(a => a.currency !== 'COP' && !mp.trm[a.currency]).length,
        trmUSD: mp.trm['USD'] || 0,
      }
    };
  }

  // ─── MODELO DE DATOS ───
const CATEGORIAS = [
    {
        value: 'Inmueble', label: 'Inmueble', desc: 'Casas, apartamentos, locales, lotes',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="category-icon"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
        subtipos: [
            { value: 'Casa o apartamento donde vivo', label: 'La casa o apartamento donde vivo', liquidez: 'Ilíquida', comp: 'mercado' },
            { value: 'Casa o apartamento arrendado', label: 'Casa o apartamento que arriendo a otros', liquidez: 'Ilíquida', comp: 'mercado' },
            { value: 'Local bodega u oficina comercial', label: 'Local, bodega u oficina comercial', liquidez: 'Ilíquida', comp: 'mercado' },
            { value: 'Lote o terreno', label: 'Un lote o terreno', liquidez: 'Ilíquida', comp: 'mercado' }
        ]
    },
    {
        value: 'Financiero', label: 'Financiero', desc: 'Cuentas, inversiones, CDTs, fondos',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="category-icon"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
        subtipos: [
            { value: 'Cuenta bancaria corriente o ahorros', label: 'Cuenta bancaria (corriente o ahorros)', liquidez: 'Alta', comp: 'estable' },
            { value: 'Cuenta de alto rendimiento', label: 'Cuenta de alto rendimiento (Pibank, Lulo, Nubank…)', liquidez: 'Alta', comp: 'tasa' },
            { value: 'Efectivo en caja', label: 'Efectivo en caja / billetera', liquidez: 'Alta', comp: 'estable' },
            { value: 'Fondo de liquidez o Fiducia', label: 'Fondo de liquidez o fiducia', liquidez: 'Alta', comp: 'tasa' },
            { value: 'CDT', label: 'CDT (certificado a plazo fijo)', liquidez: 'Baja', comp: 'tasa' },
            { value: 'Cuenta AFC', label: 'Cuenta AFC (ahorro para vivienda)', liquidez: 'Media', comp: 'tasa' },
            { value: 'Acciones en bolsa', label: 'Acciones que cotizan en bolsa', liquidez: 'Media', comp: 'volatil' },
            { value: 'ETF o fondo de inversión internacional', label: 'ETF o fondo de inversión internacional', liquidez: 'Media', comp: 'volatil' },
            { value: 'Fondo de inversión colectiva FIC', label: 'Fondo de inversión colectiva (FIC)', liquidez: 'Media', comp: 'volatil' },
            { value: 'Bonos o títulos de deuda', label: 'Bonos o títulos de deuda', liquidez: 'Media', comp: 'tasa' },
            { value: 'REIT', label: 'REIT (fondo inmobiliario que cotiza)', liquidez: 'Media', comp: 'volatil' },
            { value: 'Fondo de pensiones voluntarias FPV', label: 'Fondo de pensiones voluntarias', liquidez: 'Media', comp: 'volatil' },
            { value: 'Seguro de pensión con ahorro', label: 'Seguro de pensión con ahorro', liquidez: 'Baja', comp: 'tasa' },
            { value: 'Cartera gestionada por terceros', label: 'Cartera gestionada por un tercero (family office, wealth manager)', liquidez: 'Media', comp: 'volatil' },
            { value: 'Dinero que me deben', label: 'Dinero que me deben (cuentas por cobrar, préstamos a terceros)', liquidez: 'Baja', comp: 'estable' }
        ]
    },
    {
        value: 'Empresarial', label: 'Empresarial', desc: 'Tu empresa o participación en negocios',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="category-icon"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M15 4v16"/><path d="M3 10h18"/></svg>`,
        subtipos: [
            { value: 'Mi empresa o negocio', label: 'Mi propia empresa o negocio', liquidez: 'Ilíquida', comp: 'aporte' },
            { value: 'Sociedad con socios', label: 'Sociedad con socios (SAS, Ltda, etc.)', liquidez: 'Ilíquida', comp: 'aporte' },
            { value: 'Acciones en empresa privada', label: 'Acciones en una empresa privada (no cotiza en bolsa)', liquidez: 'Ilíquida', comp: 'aporte' }
        ]
    },
    {
        value: 'Alternativo', label: 'Alternativo', desc: 'Oro, cripto, arte, regalías',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="category-icon"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
        subtipos: [
            { value: 'Oro físico', label: 'Oro físico (monedas o lingotes)', liquidez: 'Ilíquida', comp: 'mercado' },
            { value: 'Criptomonedas', label: 'Criptomonedas (Bitcoin, Ethereum, etc.)', liquidez: 'Baja', comp: 'volatil' },
            { value: 'Obras de arte joyas o coleccionables', label: 'Obras de arte, joyas o coleccionables', liquidez: 'Ilíquida', comp: 'volatil' },
            { value: 'Vehículo de trabajo', label: 'Vehículo de trabajo (Uber, taxi, carga)', liquidez: 'Ilíquida', comp: 'deprecia' },
            { value: 'Regalías derechos o patentes', label: 'Regalías, derechos de autor o patentes', liquidez: 'Ilíquida', comp: 'aporte' }
        ]
    },
    {
        value: 'Uso Personal', label: 'Uso personal', desc: 'Carro, joyas, objetos personales',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="category-icon"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
        subtipos: [
            { value: 'Carro moto o vehículo personal', label: 'Carro, moto o vehículo personal', liquidez: 'Ilíquida', comp: 'deprecia' },
            { value: 'Joyas relojes u objetos de valor', label: 'Joyas, relojes u objetos de valor', liquidez: 'Ilíquida', comp: 'volatil' }
        ]
    }
];

const ICONO_CATEGORIA = {};
CATEGORIAS.forEach(c => ICONO_CATEGORIA[c.value] = c.icon);

const DESCRIPCION_PLACEHOLDER = {
    'Inmueble': 'Ej: Apartamento en El Poblado, Casa en Llanogrande',
    'Financiero': 'Ej: Ahorros Bancolombia, Mi portafolio en Interactive Brokers',
    'Empresarial': 'Ej: Mi consultora de marketing, Mi restaurante en Provenza',
    'Alternativo': 'Ej: Mi colección de Bitcoin, Lingotes de oro en caja fuerte',
    'Uso Personal': 'Ej: Mazda CX-5 2022, Reloj de mi padre, Anillo de matrimonio'
};

const ENTIDAD_CONFIG = {
    'Cuenta bancaria corriente o ahorros': { show: true, label: 'En qué banco está', placeholder: 'Bancolombia, Davivienda, BBVA…', hint: 'Nombre del banco donde está la cuenta.' },
    'Cuenta de alto rendimiento': { show: true, label: 'En qué entidad está', placeholder: 'Pibank, Lulo Bank, Nubank, Tyba…', hint: '' },
    'Fondo de liquidez o Fiducia': { show: true, label: 'En qué fiduciaria', placeholder: 'Fiducolombia, Alianza, Bancolombia…', hint: '' },
    'CDT': { show: true, label: 'En qué banco', placeholder: 'Bancolombia, Davivienda, BBVA…', hint: '' },
    'Cuenta AFC': { show: true, label: 'En qué banco', placeholder: 'Bancolombia, Davivienda…', hint: '' },
    'Acciones en bolsa': { show: true, label: 'En qué comisionista o broker', placeholder: 'Tradeview, Trii, Interactive Brokers, Davivienda Corredores…', hint: '' },
    'ETF o fondo de inversión internacional': { show: true, label: 'En qué broker o entidad', placeholder: 'Interactive Brokers, Schwab, Pibank, Skandia…', hint: '' },
    'Fondo de inversión colectiva FIC': { show: true, label: 'En qué administradora', placeholder: 'Credicorp Capital, Alianza, Skandia, BTG Pactual…', hint: '' },
    'Bonos o títulos de deuda': { show: true, label: 'A través de qué entidad', placeholder: 'Comisionista, banco, TES en Deceval…', hint: '' },
    'REIT': { show: true, label: 'En qué broker', placeholder: 'Interactive Brokers, Schwab, Tradeview…', hint: '' },
    'Fondo de pensiones voluntarias FPV': { show: true, label: 'En qué administradora', placeholder: 'Protección, Porvenir, Skandia, Old Mutual…', hint: '' },
    'Seguro de pensión con ahorro': { show: true, label: 'En qué aseguradora', placeholder: 'Skandia, Allianz, Bolívar, Sura, MetLife…', hint: '' },
    'Cartera gestionada por terceros': { show: true, label: 'Quién gestiona la cartera', placeholder: 'Skandia, BTG Pactual, family office, wealth manager…', hint: 'Nombre del family office, fiduciaria o gestor que administra.' },
    'Efectivo en caja': { show: false },
    'Criptomonedas': { show: true, label: 'En qué exchange o billetera', placeholder: 'Binance, Coinbase, Crypto.com, Ledger, MetaMask…', hint: 'Dónde están custodiadas tus monedas.' },
    'Regalías derechos o patentes': { show: true, label: 'Quién te paga las regalías', placeholder: 'SAYCO, Spotify, editorial, licenciatario…', hint: '' },
    'Oro físico': { show: false },
    'Obras de arte joyas o coleccionables': { show: false },
    'Vehículo de trabajo': { show: false },
};

const INGRESOS_CONFIG = {
    'Casa o apartamento donde vivo': { type: 'none' },
    'Casa o apartamento arrendado': { type: 'binario', q: '¿Cuánto recibes de arriendo al mes?', hint: 'Lo que <strong>te entra en la cuenta</strong> cada mes (descontando administración si aplica). Si está vacío hoy, marca "No".', siLabel: 'Sí, está arrendado', noLabel: 'No, está vacío', amountLabel: 'Arriendo mensual neto' },
    'Local bodega u oficina comercial': { type: 'binario', q: '¿Cuánto recibes de arriendo al mes?', hint: 'Si lo tienes arrendado a un tercero, indica el canon mensual. Si lo usas tú mismo o está vacío, marca "No".', siLabel: 'Sí, está arrendado', noLabel: 'No genera arriendo', amountLabel: 'Arriendo mensual' },
    'Lote o terreno': { type: 'binario', q: '¿Te genera algún ingreso?', hint: 'Por ejemplo: parqueadero, cultivo, alquiler temporal. Si solo lo tienes esperando que se valorice, marca "No".', siLabel: 'Sí', noLabel: 'No genera ingreso', amountLabel: 'Ingreso mensual promedio' },
    'Cuenta bancaria corriente o ahorros': { type: 'none' },
    'Efectivo en caja': { type: 'none' },
    'Cuenta de alto rendimiento': { type: 'rendimientos', q: '¿Qué pasa con los rendimientos de esta cuenta?', hint: 'Estas cuentas pagan intereses cada mes. ¿Los retiras o se quedan acumulando?' },
    'Fondo de liquidez o Fiducia': { type: 'rendimientos', q: '¿Qué pasa con los rendimientos?', hint: 'Las fiducias y fondos de liquidez generan rendimientos. ¿Los retiras o se reinvierten?' },
    'CDT': { type: 'rendimientos', q: '¿Cómo te pagan los intereses del CDT?', hint: 'Algunos CDTs pagan intereses periódicos (mes a mes o trimestralmente); otros pagan todo al vencimiento.' },
    'Cuenta AFC': { type: 'none' },
    'Acciones en bolsa': { type: 'rendimientos', q: '¿Qué pasa con los dividendos?', hint: 'Las acciones pueden pagar dividendos. ¿Los recibes en efectivo o se reinvierten automáticamente?' },
    'ETF o fondo de inversión internacional': { type: 'rendimientos', q: '¿Qué pasa con las distribuciones del fondo?', hint: 'Hay fondos de <strong>acumulación</strong> (reinvierten todo) y de <strong>distribución</strong> (pagan dividendos en efectivo).' },
    'Fondo de inversión colectiva FIC': { type: 'rendimientos', q: '¿Qué pasa con los rendimientos del FIC?', hint: 'Algunos FICs pagan rendimientos periódicos; otros los acumulan en el valor de la unidad.' },
    'Bonos o títulos de deuda': { type: 'rendimientos', q: '¿Cómo te pagan los intereses (cupones)?', hint: 'Los bonos pagan cupones periódicos (típicamente cada 6 meses o al año). ¿Los retiras o los reinviertes?' },
    'REIT': { type: 'rendimientos', q: '¿Qué pasa con los dividendos del REIT?', hint: 'Los REITs distribuyen rentas inmobiliarias en forma de dividendos. ¿Los retiras o se reinvierten?' },
    'Fondo de pensiones voluntarias FPV': { type: 'none' },
    'Seguro de pensión con ahorro': { type: 'none' },
    'Cartera gestionada por terceros': { type: 'rendimientos', q: '¿Qué pasa con los rendimientos de la cartera?', hint: 'En las carteras gestionadas tú decides la política. ¿Retiras los rendimientos o se reinvierten?' },
    'Dinero que me deben': { type: 'binario', q: '¿Te pagan intereses por ese dinero?', hint: 'Si prestaste con interés (por ejemplo, un préstamo a un familiar o negocio que te paga algo cada mes), indícalo. Si solo esperas que te devuelvan el capital, marca "No".', siLabel: 'Sí, me pagan interés', noLabel: 'No, solo me deben el capital', amountLabel: 'Interés mensual que recibo' },
    'Oro físico': { type: 'none' },
    'Criptomonedas': { type: 'binario', q: '¿Generan algún rendimiento? (staking, yield, lending)', hint: 'Algunas criptos pagan recompensas por staking o yield. Si solo las tienes esperando que se valoricen, marca "No".', siLabel: 'Sí, generan staking/yield', noLabel: 'No, solo plusvalía', amountLabel: 'Rendimiento mensual promedio' },
    'Obras de arte joyas o coleccionables': { type: 'none' },
    'Vehículo de trabajo': { type: 'binario', q: '¿Cuánto te deja este vehículo al mes (neto)?', hint: 'Ingresos menos gastos de operación (gasolina, mantenimiento, plataforma…). Lo que <strong>te queda</strong> en el bolsillo.', siLabel: 'Sí, genera ingresos', noLabel: 'No está activo', amountLabel: 'Ingreso neto mensual' },
    'Regalías derechos o patentes': { type: 'binario', q: '¿Cuánto recibes de regalías al mes en promedio?', hint: 'Promedio mensual aproximado — pueden llegar de forma irregular.', siLabel: 'Sí, recibo regalías', noLabel: 'No están generando', amountLabel: 'Regalías mensuales promedio' },
    'Carro moto o vehículo personal': { type: 'none' },
    'Joyas relojes u objetos de valor': { type: 'none' }
};

const TIPOS_DEUDA = {
    'Inmueble': ['Crédito hipotecario', 'Leasing habitacional', 'Crédito constructor', 'Crédito de libre inversión', 'Otro'],
    'Uso Personal': ['Crédito de vehículo', 'Leasing de vehículo', 'Crédito de libre inversión', 'Tarjeta de crédito', 'Crédito prendario', 'Otro'],
    'Financiero': ['Apalancamiento / Margin', 'Crédito de libre inversión usado para invertir', 'Otro'],
    'Empresarial': ['Crédito empresarial con aval personal', 'Aval o fianza personal a la empresa', 'Crédito de libre inversión usado en la empresa', 'Otro'],
    'Alternativo': ['Crédito de libre inversión', 'Otro']
};

const DEBT_SUBTITLE = {
    'Inmueble': '¿Tiene crédito hipotecario o cualquier deuda asociada a este inmueble? Si está totalmente pagado, marca "No".',
    'Uso Personal': '¿Tiene crédito asociado? (crédito de vehículo, leasing, prendario, etc.)',
    'Financiero': '¿Pediste prestado para invertir en este activo? (apalancamiento, margin loan, crédito que usaste para comprarlo)',
    'Empresarial': '¿Hay deuda personal asociada a esta empresa? (créditos con aval tuyo, fianzas personales)',
    'Alternativo': '¿Pediste un crédito para adquirir o financiar este activo?'
};

// ════════════════════════════════════════════════════════════════════════════════
// HELPERS — separador de miles automático
// ════════════════════════════════════════════════════════════════════════════════
function formatThousands(digitsStr) {
    if (!digitsStr) return '';
    const num = parseInt(digitsStr, 10);
    if (isNaN(num)) return '';
    return num.toLocaleString('es-CO');
}

function attachNumberFormat(input) {
    if (!input || input.dataset.numFormat === '1') return;
    input.dataset.numFormat = '1';

    input.addEventListener('input', (e) => {
        const oldVal = e.target.value;
        const cursorPos = e.target.selectionStart || 0;
        const digitsBefore = oldVal.substring(0, cursorPos).replace(/[^\d]/g, '').length;
        const digits = oldVal.replace(/[^\d]/g, '');
        const formatted = digits ? formatThousands(digits) : '';
        e.target.value = formatted;
        let newPos = 0, count = 0;
        if (digitsBefore === 0) {
            newPos = 0;
        } else {
            for (let i = 0; i < formatted.length; i++) {
                if (/\d/.test(formatted[i])) count++;
                if (count >= digitsBefore) { newPos = i + 1; break; }
            }
            if (count < digitsBefore) newPos = formatted.length;
        }
        try { e.target.setSelectionRange(newPos, newPos); } catch (_) {}
    });

    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const digits = text.replace(/[^\d]/g, '');
        if (digits) {
            const formatted = formatThousands(digits);
            const start = input.selectionStart, end = input.selectionEnd;
            input.value = input.value.substring(0, start) + formatted + input.value.substring(end);
            input.dispatchEvent(new Event('input'));
        }
    });
}

function getNumberValue(input) {
    if (!input) return 0;
    const digits = (input.value || '').replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}
function setNumberValue(input, val) {
    if (!input) return;
    if (val === null || val === undefined || val === 0 || isNaN(val)) input.value = '';
    else input.value = formatThousands(String(Math.round(val)));
}

const fmtCOP = (n) => {
    if (!isFinite(n) || isNaN(n)) return '— COP';
    return '$ ' + Math.round(n).toLocaleString('es-CO') + ' COP';
};
const fmtMoneyFx = (n, ccy) => {
    if (!isFinite(n) || isNaN(n) || n === 0) return '';
    const symbol = ccy === 'USD' ? 'US$ ' : ccy === 'EUR' ? '€ ' : (ccy + ' ');
    return symbol + Math.round(n).toLocaleString('es-CO');
};
const currencySymbol = (ccy) => ccy === 'USD' ? 'US$' : ccy === 'EUR' ? '€' : ccy === 'GBP' ? '£' : '$';

// ════════════════════════════════════════════════════════════════════════════════
// ESTADO

// ════════════════════════════════════════════════════════════════════════════════
// CÁLCULOS  (integrado: la deuda vive en el Módulo 2, el activo solo guarda IDs)
// ════════════════════════════════════════════════════════════════════════════════
function convertirACOP(valor, moneda) {
    if (!valor || isNaN(valor)) return NaN;
    if (moneda === 'COP') return valor;
    const rate = mp.trm[moneda];
    if (!rate || rate <= 0) return NaN;
    return valor * rate;
}

// Saldo total (en COP) de las deudas del M2 enlazadas a este activo.
// Las deudas del M2 ya están en COP, por eso NO se reconvierten.
function linkedDebtCOP(asset) {
    const ids = asset.deudasVinculadas || [];
    if (!ids.length) return 0;
    return ids.reduce((acc, id) => {
        const d = host.getDeudaById(id);
        return acc + (d && isFinite(d.saldo) ? (d.saldo || 0) : 0);
    }, 0);
}

// ¿Tiene algún enlace que ya no existe en el M2? (deuda borrada allá)
function hasOrphanDebt(asset) {
    const ids = asset.deudasVinculadas || [];
    return ids.some(id => !host.getDeudaById(id));
}

// Parte del activo que es del usuario (activos compartidos). 1 = 100% suyo.
function shareFactor(asset) {
    const p = (asset && asset.porcentajePropio != null && asset.porcentajePropio > 0 && asset.porcentajePropio <= 100)
        ? asset.porcentajePropio : 100;
    return p / 100;
}

function valueCOP(asset) {
    const total = convertirACOP(asset.value, asset.currency);
    if (isNaN(total)) return total;
    // Si el activo es compartido, solo cuenta la parte que es del usuario
    return total * shareFactor(asset);
}

function netWorthCOP(asset) {
    const valCOP = valueCOP(asset);
    if (isNaN(valCOP)) return NaN;
    return valCOP - linkedDebtCOP(asset);
}

function totalNetWorth() {
    return mp.assets.reduce((acc, a) => {
        const nw = netWorthCOP(a);
        return acc + (isFinite(nw) ? nw : 0);
    }, 0);
}

function totalGrossAssets() {
    return mp.assets.reduce((acc, a) => {
        const v = valueCOP(a);
        return acc + (isFinite(v) ? v : 0);
    }, 0);
}

// Deuda total = suma de saldos del M2 que están enlazados a algún activo del mapa.
function totalDebt() {
    return mp.assets.reduce((acc, a) => acc + linkedDebtCOP(a), 0);
}

function usedForeignCurrencies() {
    const set = new Set();
    mp.assets.forEach(a => { if (a.currency && a.currency !== 'COP') set.add(a.currency); });
    return Array.from(set);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function findSubtype(catVal, subVal) {
    const cat = CATEGORIAS.find(c => c.value === catVal);
    return cat ? (cat.subtipos.find(s => s.value === subVal) || null) : null;
}
function findSubtypeLabel(catVal, subVal) {
    const s = findSubtype(catVal, subVal);
    return s ? s.label : (subVal || '');
}

// ════════════════════════════════════════════════════════════════════════════════
// MOTOR DE VALORIZACIÓN Y PROYECCIÓN — comportamiento por tipo de activo
// El usuario nunca ve estas etiquetas; el código las usa para decidir qué calcular.
//   tasa     → paga una tasa conocida (CDT, cuenta alto rendimiento, bonos)
//   mercado  → se valoriza con el mercado (inmuebles, oro)
//   volatil  → sube y baja mucho (cripto, acciones, fondos) — no se proyecta
//   estable  → no cambia solo (efectivo, cuentas)
//   deprecia → pierde valor (carros, vehículos)
//   aporte   → depende de aportes/utilidades (empresas, FPV, pensiones) — no se proyecta
// ════════════════════════════════════════════════════════════════════════════════

// Tasas por defecto (editables). Solo se usan como punto de partida visible al usuario.
const TASAS_DEFECTO = {
    deprecia: 0.12,   // vehículos: ~12% anual a la baja
};

// Subtipos que muestran el campo de sector (financieros ligados a empresas/mercados).
// Alineado con Arquitectura Patrimonial.
const SUBTIPOS_CON_SECTOR = [
    'Acciones en bolsa',
    'ETF o fondo de inversión internacional',
    'Fondo de inversión colectiva FIC',
    'Bonos o títulos de deuda',
    'REIT',
    'Cartera gestionada por terceros',
    'Acciones en empresa privada',
];
// Sector sugerido por defecto para algunos subtipos (el usuario puede cambiarlo).
const SECTOR_POR_DEFECTO = {
    'ETF o fondo de inversión internacional': 'Global / Diversificado',
    'REIT': 'Real Estate / Inmobiliario',
};

// ── Naturaleza de cada subtipo, para mostrar solo las preguntas que aplican ──
// Vehículos/pólizas de ahorro pensional: son individuales (a nombre de una sola persona),
// inembargables por ley, no se dan en garantía, y al fallecer el titular se ENTREGA el
// dinero a los beneficiarios (no se heredan "en marcha"). Requieren trato especial.
const SUBTIPOS_PENSIONALES = [
    'Fondo de pensiones voluntarias FPV',
    'Seguro de pensión con ahorro',
];
function esPensional(sub){ return SUBTIPOS_PENSIONALES.indexOf(sub) !== -1; }

// Subtipos donde NO aplica la pregunta de deuda/apalancamiento: dinero líquido o por cobrar.
// No se dan en garantía ni se compran con crédito, así que preguntar "¿respalda una deuda?"
// o "¿pediste prestado para invertir?" no tiene sentido (ej. efectivo, cuentas, CDT).
const SUBTIPOS_SIN_DEUDA = [
    'Cuenta bancaria corriente o ahorros',
    'Cuenta de alto rendimiento',
    'Efectivo en caja',
    'Fondo de liquidez o Fiducia',
    'CDT',
    'Cuenta AFC',
    'Dinero que me deben',
];
// ¿Aplica el paso de deuda para este subtipo? (los pensionales tampoco tienen deuda)
function aplicaDeuda(sub){ return !esPensional(sub) && SUBTIPOS_SIN_DEUDA.indexOf(sub) === -1; }

// Subtipos con un costo de adquisición real que se valorizan desde ahí: tiene sentido
// preguntar "¿cuánto valía cuando lo obtuviste?" para calcular cuánto ha crecido.
const SUBTIPOS_CON_VALOR_COMPRA = [
    'Casa o apartamento donde vivo','Casa o apartamento arrendado','Local bodega u oficina comercial','Lote o terreno',
    'Acciones en bolsa','ETF o fondo de inversión internacional','Fondo de inversión colectiva FIC','REIT','Cartera gestionada por terceros',
    'Oro físico','Criptomonedas','Obras de arte joyas o coleccionables',
    'Acciones en empresa privada','Joyas relojes u objetos de valor',
];
function tieneValorCompra(sub){ return SUBTIPOS_CON_VALOR_COMPRA.indexOf(sub) !== -1; }

// Inversiones donde tiene sentido preguntar si están puestas en una sola empresa o repartidas
// en muchas (para medir concentración). Se excluyen los productos de un solo emisor por
// naturaleza: los bonos son deuda de un único emisor, y un REIT es una sola compañía.
const SUBTIPOS_REPARTO = [
    'Acciones en bolsa',
    'ETF o fondo de inversión internacional',
    'Fondo de inversión colectiva FIC',
    'Cartera gestionada por terceros',
    'Acciones en empresa privada',
    'Criptomonedas',
];

// ¿Es un activo "productivo"? (puede financiar tu retiro bajo la regla del 4%)
// Excluye liquidez pura, residencia principal, uso personal y pensiones cautivas.
const SUBTIPOS_NO_PRODUCTIVOS = [
    'Cuenta bancaria corriente o ahorros',
    'Efectivo en caja',
    'Fondo de liquidez o Fiducia',
];
function esActivoProductivo(asset) {
    const cat = asset.category || '';
    const sub = asset.subtype || '';
    if (cat === 'Uso Personal') return false;
    if (SUBTIPOS_NO_PRODUCTIVOS.includes(sub)) return false;
    if (sub === 'Casa o apartamento donde vivo') return false;
    return (
        cat === 'Financiero' ||
        (cat === 'Inmueble' && sub !== 'Casa o apartamento donde vivo') ||
        (cat === 'Alternativo' && !!asset.generatesIncome) ||
        cat === 'Empresarial' ||
        !!asset.generatesIncome
    );
}

// Devuelve el comportamiento de un activo a partir de su subtipo.
// Horizonte real de salida por subtipo: en cuánto tiempo (y con qué costo) se vuelve efectivo.
// 'inmediato' = hoy mismo · 'dias' = pocos días hábiles · 'penalidad' = accesible pero sacarlo antes cuesta
// · 'meses' = requiere vender y suele tomar semanas o meses.
const HORIZONTE_LIQUIDEZ = {
    'Cuenta bancaria corriente o ahorros': 'inmediato',
    'Cuenta de alto rendimiento': 'inmediato',
    'Efectivo en caja': 'inmediato',
    'Fondo de liquidez o Fiducia': 'inmediato',
    'Acciones en bolsa': 'dias',
    'ETF o fondo de inversión internacional': 'dias',
    'Fondo de inversión colectiva FIC': 'dias',
    'Bonos o títulos de deuda': 'dias',
    'REIT': 'dias',
    'Cartera gestionada por terceros': 'dias',
    'Fondo de pensiones voluntarias FPV': 'dias',
    'Cuenta AFC': 'penalidad',
    'CDT': 'penalidad',
    'Seguro de pensión con ahorro': 'penalidad',
    'Criptomonedas': 'dias',
    'Dinero que me deben': 'meses',
    // Todo lo demás (inmuebles, negocios, vehículos, coleccionables) → 'meses' por defecto.
};
function horizonteLiquidez(asset) {
    if (!asset) return 'meses';
    const h = HORIZONTE_LIQUIDEZ[asset.subtype];
    if (h) return h;
    // Fallback por si el subtipo no está mapeado: usar la etiqueta de liquidez.
    const s = findSubtype(asset.category, asset.subtype);
    const liq = s ? s.liquidez : asset.liquidity;
    return (liq === 'Alta') ? 'inmediato' : (liq === 'Media') ? 'dias' : (liq === 'Baja') ? 'penalidad' : 'meses';
}

function comportamientoActivo(asset) {
    const s = findSubtype(asset.category, asset.subtype);
    return (s && s.comp) ? s.comp : 'estable';
}

// ¿Este activo admite proyección a futuro? (según la regla: sin dato real, no se proyecta)
function admiteProyeccion(asset) {
    const comp = comportamientoActivo(asset);
    if (comp === 'tasa')     return (asset.tasaRendimiento || 0) > 0;            // necesita la tasa
    if (comp === 'deprecia') return true;                                       // siempre proyecta a la baja
    if (comp === 'mercado')  return !!(asset.valorAdquisicion && asset.anioAdquisicion); // necesita compra+año
    return false;                                                               // volatil, estable, aporte → no se proyecta
}

// ¿Se puede calcular cuánto ha crecido (valorización pasada)?
function admiteValorizacion(asset) {
    const comp = comportamientoActivo(asset);
    if (comp === 'estable' || comp === 'aporte') return false;
    if (!asset.valorAdquisicion || !asset.anioAdquisicion) return false;
    // Requiere al menos ~0,5 años desde la compra
    const anios = aniosDesde(asset.anioAdquisicion, asset.mesAdquisicion);
    return anios >= 0.5;
}

// Años transcurridos desde una fecha de adquisición (año + mes opcional) hasta hoy.
function aniosDesde(anio, mes) {
    if (!anio) return 0;
    const ahora = new Date();
    const m = (mes && mes >= 1 && mes <= 12) ? (mes - 1) : 0;
    const inicio = new Date(anio, m, 1);
    const ms = ahora - inicio;
    return ms > 0 ? ms / (365.25 * 24 * 3600 * 1000) : 0;
}

// Valorización pasada: % anualizado (CAGR) y ganancia absoluta, en la moneda del activo.
function calcValorizacion(asset) {
    if (!admiteValorizacion(asset)) return null;
    // Si el activo es compartido, la ganancia es solo la parte del usuario (el % anualizado no cambia).
    const sh = shareFactor(asset);
    const actual = (asset.value || 0) * sh;
    const compra = (asset.valorAdquisicion || 0) * sh;
    if (compra <= 0 || actual <= 0) return null;
    const anios = aniosDesde(asset.anioAdquisicion, asset.mesAdquisicion);
    if (anios < 0.5) return null;
    const ganancia = actual - compra;
    const cagr = Math.pow(actual / compra, 1 / anios) - 1;
    return { ganancia, cagr, anios };
}

// Proyección a futuro a N años, en la moneda del activo. Devuelve null si no admite proyección.
function calcProyeccion(asset, anios) {
    if (!admiteProyeccion(asset)) return null;
    const comp = comportamientoActivo(asset);
    // Solo se proyecta la parte del activo que es del usuario.
    const actual = (asset.value || 0) * shareFactor(asset);
    if (actual <= 0) return null;
    let tasa;
    if (comp === 'tasa')     tasa = asset.tasaRendimiento || 0;
    else if (comp === 'deprecia') tasa = -(asset.tasaDepreciacion || TASAS_DEFECTO.deprecia);
    else if (comp === 'mercado') {
        // Usa la valorización histórica real del propio activo como ritmo (no un supuesto externo)
        const v = calcValorizacion(asset);
        if (!v) return null;
        tasa = v.cagr;
    } else return null;
    const futuro = actual * Math.pow(1 + tasa, anios);
    return { futuro, tasa, anios, comp };
}

// Frase humana para la tarjeta: cuánto ha crecido (o perdido) un activo. null si no aplica.
function fraseValorizacion(asset) {
    const v = calcValorizacion(asset);
    if (!v) return null;
    const pct = Math.round(v.cagr * 1000) / 10; // 1 decimal
    if (Math.abs(pct) < 0.1) return null;
    if (pct > 0) return `Ha crecido cerca de ${pct}% al año desde que lo obtuviste`;
    return `Ha bajado cerca de ${Math.abs(pct)}% al año desde que lo obtuviste`;
}



function renderInventory() {
    const total = totalNetWorth();
    const debt = totalDebt();
    const pendientes = mp.assets.filter(a => a.currency !== 'COP' && !mp.trm[a.currency]).length;

    document.getElementById('stat-net-worth').textContent = fmtCOP(total);
    document.getElementById('stat-count').textContent = mp.assets.length;
    document.getElementById('stat-debt-sub').textContent = debt > 0
        ? 'Deudas totales: ' + fmtCOP(debt)
        : 'Sin deudas registradas';

    const note = document.getElementById('summary-note');
    if (pendientes > 0) {
        note.classList.add('visible');
        note.textContent = `Hay ${pendientes} activo${pendientes === 1 ? '' : 's'} en otra moneda que aún no se han convertido. Completa los tipos de cambio abajo para que se sumen al total.`;
    } else {
        note.classList.remove('visible');
        note.textContent = '';
    }

    renderTRMCard();

    const hasAssets = mp.assets.length > 0;
    document.getElementById('empty-state').style.display = hasAssets ? 'none' : 'block';
    document.getElementById('asset-cards').style.display = hasAssets ? 'grid' : 'none';
    const addMoreBtn = document.getElementById('btn-add-more');
    if (addMoreBtn) addMoreBtn.style.display = hasAssets ? 'flex' : 'none';
    document.getElementById('asset-count-inline').textContent = hasAssets ? `(${mp.assets.length})` : '';

    renderAssetCardsOnly();
    emitChange();
}

function renderAssetCardsOnly() {
    const container = document.getElementById('asset-cards');
    container.innerHTML = mp.assets.map(a => {
        const nw = netWorthCOP(a);
        const subtipoLabel = findSubtypeLabel(a.category, a.subtype);
        const fxStr = a.currency !== 'COP' ? fmtMoneyFx(a.value, a.currency) : '';
        const _debtCOP = linkedDebtCOP(a);
        const _orphan = hasOrphanDebt(a);
        const debtStr = _debtCOP > 0 ? ' · Deuda: ' + fmtCOP(_debtCOP) : '';
        const orphanStr = _orphan ? ' · <span class="asset-card-orphan">enlace de deuda desactualizado</span>' : '';
        const compartidoStr = (a.esCompartido && a.porcentajePropio < 100)
            ? ` · <span class="asset-card-cond">Compartido · tu ${a.porcentajePropio}%</span>` : '';
        const restringidoStr = a.restringidoLegal
            ? ` · <span class="asset-card-cond restringido">Restringido · no disponible</span>` : '';
        const valFrase = fraseValorizacion(a);
        const valFraseHtml = valFrase ? `<div class="asset-card-growth">${escapeHtml(valFrase)}</div>` : '';
        const valueHtml = isFinite(nw)
            ? `<div class="asset-card-value">${fmtCOP(nw)}</div>${fxStr ? `<div class="asset-card-value-sub">${fxStr}</div>` : ''}`
            : `<div class="asset-card-value pending">Pendiente conversión</div>${fxStr ? `<div class="asset-card-value-sub">${fxStr}</div>` : ''}`;
        return `
        <div class="asset-card">
            <div class="asset-card-icon">${ICONO_CATEGORIA[a.category] || ''}</div>
            <div class="asset-card-body">
                <div class="asset-card-name">${escapeHtml(a.description)}</div>
                <div class="asset-card-meta">
                    <span class="asset-card-tag">${a.category}</span>${escapeHtml(subtipoLabel || a.subtype || '')}${a.which ? ' · ' + escapeHtml(a.which) : ''}${debtStr}${orphanStr}${compartidoStr}${restringidoStr}
                </div>
                ${valFraseHtml}
            </div>
            <div class="asset-card-right">
                ${valueHtml}
                <div class="asset-card-actions">
                    <button onclick="window.__editAsset('${a.id}')" aria-label="Editar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                    <button class="btn-delete" onclick="window.__deleteAsset('${a.id}')" aria-label="Eliminar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                </div>
            </div>
        </div>`;
    }).join('');
}

function renderTRMCard() {
    const monedas = usedForeignCurrencies();
    const card = document.getElementById('trm-card');
    const rows = document.getElementById('trm-rows');
    card.classList.toggle('visible', monedas.length > 0);
    if (monedas.length === 0) { rows.innerHTML = ''; return; }
    const ccyNames = { USD: 'dólar', EUR: 'euro', GBP: 'libra', MXN: 'peso mexicano', BRL: 'real', CLP: 'peso chileno', PEN: 'sol', ARS: 'peso argentino' };
    rows.innerHTML = monedas.map(ccy => `
        <div class="trm-row">
            <label>1 ${ccy} =</label>
            <input type="text" data-trm="${ccy}" placeholder="Ej: ${ccy === 'USD' ? '4.200' : ccy === 'EUR' ? '4.600' : ''}" inputmode="numeric" autocomplete="off">
            <span class="trm-suffix">COP <span style="opacity:.7;font-weight:400">(${ccyNames[ccy] || ccy})</span></span>
        </div>
    `).join('');

    rows.querySelectorAll('input[data-trm]').forEach(inp => {
        const ccy = inp.dataset.trm;
        attachNumberFormat(inp);
        setNumberValue(inp, mp.trm[ccy] || 0);
        inp.addEventListener('input', () => {
            mp.trm[ccy] = getNumberValue(inp);
            mpSave();
            const total = totalNetWorth();
            const debt = totalDebt();
            const pendientes = mp.assets.filter(a => a.currency !== 'COP' && !mp.trm[a.currency]).length;
            document.getElementById('stat-net-worth').textContent = fmtCOP(total);
            document.getElementById('stat-debt-sub').textContent = debt > 0 ? 'Deudas totales: ' + fmtCOP(debt) : 'Sin deudas registradas';
            const note = document.getElementById('summary-note');
            if (pendientes > 0) {
                note.classList.add('visible');
                note.textContent = `Hay ${pendientes} activo${pendientes === 1 ? '' : 's'} en otra moneda que aún no se han convertido.`;
            } else {
                note.classList.remove('visible');
                note.textContent = '';
            }
            renderAssetCardsOnly();
        });
    });
}

// ════════════════════════════════════════════════════════════════════════════════
// WIZARD / MODAL
// ════════════════════════════════════════════════════════════════════════════════
function openAssetModal(editId) {
    mp.editingId = editId || null;
    if (editId) {
        const existing = mp.assets.find(a => a.id === editId);
        if (!existing) return;
        mp.draft = {
            id: existing.id,
            category: existing.category || '',
            subtype: existing.subtype || '',
            description: existing.description || '',
            which: existing.which || '',
            currency: existing.currency || 'COP',
            value: existing.value || 0,
            tasaRendimiento: existing.tasaRendimiento || 0,
            valorAdquisicion: existing.valorAdquisicion || 0,
            anioAdquisicion: existing.anioAdquisicion || null,
            tasaDepreciacion: existing.tasaDepreciacion || 0,
            beneficioTributario: !!existing.beneficioTributario,
            vigenciaCumplida: !!existing.vigenciaCumplida,
            reparto: existing.reparto || '',
            fpvInstitucional: !!existing.fpvInstitucional,
            fpvPermanencia: !!existing.fpvPermanencia,
            esCompartido: !!existing.esCompartido,
            porcentajePropio: (existing.porcentajePropio != null ? existing.porcentajePropio : 100),
            restringidoLegal: !!existing.restringidoLegal,
            deudasVinculadas: Array.isArray(existing.deudasVinculadas) ? existing.deudasVinculadas.slice() : [],
            hasDebt: ((existing.deudasVinculadas && existing.deudasVinculadas.length) > 0) ? 'si' : 'no',
            location: existing.location || 'Colombia',
            legalStructure: existing.legalStructure || 'Propiedad Directa',
            legalStructureOtro: existing.legalStructureOtro || '',
            sector: existing.sector || '',
            rolEmpresarial: existing.rolEmpresarial || '',
            rolEmpresarialOtro: existing.rolEmpresarialOtro || '',
            empRetiro: existing.empRetiro || null,
            empSalarioMensual: existing.empSalarioMensual || 0,
            empUtilidadesAnual: existing.empUtilidadesAnual || 0,
            empUtilidadesFreq: existing.empUtilidadesFreq || 'irregular',
            incomeRendimientos: existing.incomeRendimientos || null,
            hasIncome: existing.hasIncome || null,
            monthlyIncome: existing.monthlyIncome || 0,
        };
    } else {
        mp.draft = {
            id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            category: '', subtype: '',
            description: '', which: '',
            currency: 'COP', value: 0,
            hasDebt: null, deudasVinculadas: [],
            location: 'Colombia', legalStructure: 'Propiedad Directa', legalStructureOtro: '',
            sector: '',
            rolEmpresarial: '', rolEmpresarialOtro: '',
            empRetiro: null, empSalarioMensual: 0, empUtilidadesAnual: 0, empUtilidadesFreq: 'irregular',
            incomeRendimientos: null, hasIncome: null, monthlyIncome: 0,
            esCompartido: false, porcentajePropio: 100, restringidoLegal: false,
        };
    }
    mp.currentStep = 1;
    renderWizardState();
    document.getElementById('asset-modal').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeAssetModal() {
    document.getElementById('asset-modal').classList.remove('open');
    document.body.style.overflow = '';
    mp.draft = null;
    mp.editingId = null;
    clearErrors();
}

function clearErrors() {
    document.querySelectorAll('.error-msg').forEach(e => e.classList.remove('show'));
}

function renderCategoryGrid() {
    const grid = document.getElementById('category-grid');
    grid.innerHTML = CATEGORIAS.map(c => `
        <button type="button" class="category-card${mp.draft.category === c.value ? ' selected' : ''}" data-cat="${c.value}">
            ${c.icon}
            <div class="category-name">${c.label}</div>
            <div class="category-desc">${c.desc}</div>
        </button>
    `).join('');
    grid.querySelectorAll('.category-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.cat;
            if (mp.draft.category !== val) {
                mp.draft.category = val;
                mp.draft.subtype = '';
                mp.draft.sector = '';
                mp.draft.rolEmpresarial = '';
                mp.draft.rolEmpresarialOtro = '';
                mp.draft.empRetiro = null;
                mp.draft.incomeRendimientos = null;
                mp.draft.hasIncome = null;
                mp.draft.monthlyIncome = 0;
                mp.draft.empSalarioMensual = 0;
                mp.draft.empUtilidadesAnual = 0;
                mp.draft.deudasVinculadas = [];
                mp.draft.hasDebt = null;
            }
            renderCategoryGrid();
            clearErrors();
        });
    });
}

function renderSubtypeList() {
    const cat = CATEGORIAS.find(c => c.value === mp.draft.category);
    if (!cat) return;
    document.getElementById('step2-title').textContent = `¿Cuál ${cat.label.toLowerCase()} exactamente?`;
    const list = document.getElementById('subtype-list');
    list.innerHTML = cat.subtipos.map(s => `
        <button type="button" class="subtype-option${mp.draft.subtype === s.value ? ' selected' : ''}" data-sub="${escapeHtml(s.value)}">
            <span class="subtype-radio"></span>
            <span>${s.label}</span>
        </button>
    `).join('');
    list.querySelectorAll('.subtype-option').forEach(btn => {
        btn.addEventListener('click', () => {
            if (mp.draft.subtype !== btn.dataset.sub) {
                mp.draft.subtype = btn.dataset.sub;
                mp.draft.incomeRendimientos = null;
                mp.draft.hasIncome = null;
                mp.draft.monthlyIncome = 0;
            }
            renderSubtypeList();
            clearErrors();
        });
    });
}

function renderStep3() {
    const cat = mp.draft.category;
    const sub = mp.draft.subtype;
    const descPh = DESCRIPCION_PLACEHOLDER[cat] || 'Algo que te ayude a identificarlo';
    const descInput = document.getElementById('asset-description');
    descInput.placeholder = descPh;
    descInput.value = mp.draft.description || '';

    const entCfg = ENTIDAD_CONFIG[sub];
    const whichField = document.getElementById('asset-which-field');
    const whichLabel = document.getElementById('which-label');
    const whichInput = document.getElementById('asset-which');
    const whichHint = document.getElementById('which-hint');

    if (entCfg && entCfg.show) {
        whichField.style.display = 'block';
        whichLabel.innerHTML = `${entCfg.label} <span class="optional">(opcional)</span>`;
        whichInput.placeholder = entCfg.placeholder || '';
        whichHint.innerHTML = entCfg.hint || '';
        whichHint.style.display = entCfg.hint ? 'block' : 'none';
        whichInput.value = mp.draft.which || '';
    } else {
        whichField.style.display = 'none';
        whichInput.value = '';
    }

    document.getElementById('asset-currency').value = mp.draft.currency || 'COP';
    setNumberValue(document.getElementById('asset-value'), mp.draft.value);
    updateCurrencyPrefix();
    updateValueCOPDisplay();
    renderCamposProyeccion();
}

// Muestra solo los campos de valorización/proyección que aplican al tipo de activo.
function renderCamposProyeccion() {
    const sub = findSubtype(mp.draft.category, mp.draft.subtype);
    const comp = (sub && sub.comp) ? sub.comp : 'estable';

    const tasaField   = document.getElementById('asset-tasa-field');
    const compraBlock = document.getElementById('asset-compra-block');
    const notaBox     = document.getElementById('asset-comp-nota');
    const notaText    = document.getElementById('asset-comp-nota-text');
    if (!tasaField || !compraBlock || !notaBox) return;

    // Reset
    tasaField.style.display = 'none';
    compraBlock.style.display = 'none';
    notaBox.style.display = 'none';

    // Precargar valores existentes (modo edición)
    const tasaInput = document.getElementById('asset-tasa');
    if (tasaInput) tasaInput.value = (mp.draft.tasaRendimiento ? (mp.draft.tasaRendimiento * 100) : '');
    setNumberValue(document.getElementById('asset-valor-compra'), mp.draft.valorAdquisicion || 0);
    const anioInput = document.getElementById('asset-anio-compra');
    if (anioInput) anioInput.value = mp.draft.anioAdquisicion || '';
    const compraPrefix = document.getElementById('compra-prefix');
    if (compraPrefix) compraPrefix.textContent = currencySymbol(mp.draft.currency || 'COP');

    if (comp === 'tasa') {
        tasaField.style.display = 'block';
    } else if (comp === 'mercado') {
        compraBlock.style.display = 'block';
    } else if (comp === 'volatil') {
        compraBlock.style.display = 'block';
        notaBox.style.display = 'flex';
        notaText.textContent = 'Este tipo de inversión sube y baja mucho, así que no predecimos cuánto valdrá. Te mostramos lo que vale hoy y, si nos dices cuánto valía cuando lo obtuviste, cuánto ha cambiado.';
    } else if (comp === 'deprecia') {
        notaBox.style.display = 'flex';
        notaText.textContent = 'Las cosas como los carros van perdiendo valor con los años. Más adelante te mostramos una estimación de cuánto podría valer.';
    } else if (comp === 'aporte') {
        notaBox.style.display = 'flex';
        notaText.textContent = 'Cuánto valga esto a futuro depende de cuánto le sigas aportando y de cómo le vaya, así que no lo proyectamos con una fórmula. Lo dejamos en el valor que nos das hoy.';
    } else { // estable
        notaBox.style.display = 'flex';
        notaText.textContent = 'El dinero disponible no crece por sí solo, e incluso pierde poder de compra con la inflación. Lo mantenemos en su valor actual.';
    }

    // Los productos pensionales (FPV, seguro de pensión con ahorro) no tienen un "precio de
    // compra" que se valorice: se van formando con aportes y rendimiento en el tiempo. Por eso
    // no preguntamos "¿cuánto valía cuando lo obtuviste?" ni una tasa fija.
    if (esPensional(mp.draft.subtype)) {
        tasaField.style.display = 'none';
        compraBlock.style.display = 'none';
        notaBox.style.display = 'flex';
        notaText.textContent = 'Este producto se va formando con tus aportes y su rendimiento a lo largo del tiempo, así que no lo proyectamos con una fórmula. Lo dejamos en el valor que nos das hoy.';
    } else if (compraBlock.style.display === 'block' && !tieneValorCompra(mp.draft.subtype)) {
        // Salvaguarda: si algún subtipo sin costo de adquisición llegara a activar el bloque,
        // lo ocultamos para no pedir un dato que no aplica.
        compraBlock.style.display = 'none';
    }
}

function updateCurrencyPrefix() {
    const ccy = document.getElementById('asset-currency').value;
    const sym = currencySymbol(ccy);
    document.getElementById('currency-prefix').textContent = sym;
    const debtPrefix = document.getElementById('debt-currency-prefix');
    if (debtPrefix) debtPrefix.textContent = sym;
}

function updateValueCOPDisplay() {
    const ccy = document.getElementById('asset-currency').value;
    const val = getNumberValue(document.getElementById('asset-value'));
    const display = document.getElementById('asset-value-cop-display');
    const valueLabel = document.getElementById('asset-value-cop');
    const labelEl = document.getElementById('value-cop-label');
    if (ccy === 'COP' || val === 0) { display.style.display = 'none'; return; }
    display.style.display = 'flex';
    const rate = mp.trm[ccy];
    if (!rate || rate <= 0) {
        labelEl.textContent = 'En pesos:';
        valueLabel.textContent = 'lo calculamos al guardar';
        valueLabel.classList.add('pending');
    } else {
        labelEl.textContent = 'Equivale en pesos a:';
        valueLabel.textContent = fmtCOP(val * rate);
        valueLabel.classList.remove('pending');
    }
}

function renderStep4() {
    const cat = mp.draft.category;
    document.getElementById('debt-subtitle').textContent = DEBT_SUBTITLE[cat] || '¿Este activo respalda alguna deuda que ya registraste en Endeudamiento?';
    if (!Array.isArray(mp.draft.deudasVinculadas)) mp.draft.deudasVinculadas = [];

    // Selección Sí/No
    document.querySelectorAll('.yesno-option[data-debt]').forEach(opt => {
        opt.classList.toggle('selected', mp.draft.hasDebt === opt.dataset.debt);
    });
    const detail = document.getElementById('debt-detail');
    detail.style.display = mp.draft.hasDebt === 'si' ? 'block' : 'none';
    if (mp.draft.hasDebt !== 'si') return;

    // Lista de deudas existentes del M2 (las que el usuario ya registró en Endeudamiento)
    const deudas = host.getDeudas().filter(d => (d.saldo || 0) > 0 || (d.nombre || '').trim());
    const linked = mp.draft.deudasVinculadas;
    const listEl = document.getElementById('debt-link-list');

    if (deudas.length === 0) {
        listEl.innerHTML = `<div class="debt-link-empty">No tienes deudas registradas en el módulo de Endeudamiento. Crea la deuda de este activo aquí abajo y quedará registrada allá automáticamente.</div>`;
    } else {
        listEl.innerHTML = deudas.map(d => {
            const checked = linked.includes(d.id) ? 'checked' : '';
            const saldoStr = d.saldo > 0 ? fmtCOP(d.saldo) : 'sin saldo';
            const nombre = escapeHtml(d.nombre || 'Deuda sin nombre');
            return `<label class="debt-link-row">
                <input type="checkbox" class="debt-link-check" data-deuda-id="${escapeHtml(d.id)}" ${checked}>
                <span class="debt-link-info"><span class="debt-link-name">${nombre}</span><span class="debt-link-saldo">${saldoStr}</span></span>
            </label>`;
        }).join('');
    }

    // Tipos de deuda sugeridos para el mini-formulario (por categoría del bien)
    const tipos = TIPOS_DEUDA[cat] || ['Otro'];
    const selTipo = document.getElementById('new-debt-type');
    if (selTipo) {
        selTipo.innerHTML = '<option value="">Tipo de deuda…</option>' +
            tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    }
    // Reset mini-form
    const nf = document.getElementById('new-debt-form');
    if (nf) nf.style.display = 'none';
    const ndName = document.getElementById('new-debt-name');
    const ndSaldo = document.getElementById('new-debt-saldo');
    if (ndName) ndName.value = '';
    if (ndSaldo) ndSaldo.value = '';

    updateNetWorthPreview();
}

// Crea una deuda nueva directamente en el Módulo 2 (opción B) y la enlaza al activo.
function createAndLinkDebt() {
    const name = (document.getElementById('new-debt-name').value || '').trim();
    const saldo = getNumberValue(document.getElementById('new-debt-saldo'));
    const tipoMapa = document.getElementById('new-debt-type').value;
    const errEl = document.getElementById('err-new-debt');
    if (!name || saldo <= 0) {
        errEl.textContent = 'Escribe un nombre y el saldo pendiente de la deuda.';
        errEl.classList.add('show');
        return;
    }
    errEl.classList.remove('show');
    // La deuda se da de alta en el M2. El saldo del M2 está en COP:
    // si el bien está en otra moneda, convertimos el saldo a COP con la TRM.
    let saldoCOP = saldo;
    if (mp.draft.currency && mp.draft.currency !== 'COP') {
        const conv = convertirACOP(saldo, mp.draft.currency);
        saldoCOP = isFinite(conv) ? conv : saldo;
    }
    const newId = host.createDeuda({
        nombre: name,
        saldo: saldoCOP,
        tipoMapa: tipoMapa,
        categoriaActivo: mp.draft.category,
        origenMapa: true
    });
    if (newId) {
        mp.draft.deudasVinculadas.push(newId);
        renderStep4();
        showToast('Deuda creada y enlazada · también aparece en Endeudamiento');
    }
}

function updateNetWorthPreview() {
    const val = mp.draft.value || 0;
    const ccy = mp.draft.currency;
    const preview = document.getElementById('net-worth-preview');
    // Suma de saldos (COP) de las deudas enlazadas en el draft
    const ids = mp.draft.deudasVinculadas || [];
    const debtCOP = ids.reduce((acc, id) => {
        const d = host.getDeudaById(id);
        return acc + (d && isFinite(d.saldo) ? (d.saldo || 0) : 0);
    }, 0);
    if (debtCOP <= 0 || val <= 0) { preview.style.display = 'none'; return; }
    let valCOP = val;
    if (ccy !== 'COP') {
        const rate = mp.trm[ccy];
        if (!rate || rate <= 0) {
            preview.style.display = 'flex';
            document.getElementById('net-worth-value').textContent = 'Pendiente conversión';
            return;
        }
        valCOP = val * rate;
    }
    preview.style.display = 'flex';
    document.getElementById('net-worth-value').textContent = fmtCOP(valCOP - debtCOP);
}

function renderStep5() {
    const cat = mp.draft.category;
    const sub = mp.draft.subtype;

    document.getElementById('asset-location').value = mp.draft.location || 'Colombia';
    document.getElementById('asset-legal-structure').value = mp.draft.legalStructure || 'Propiedad Directa';
    const legalOtroField = document.getElementById('legal-structure-otro-field');
    legalOtroField.style.display = mp.draft.legalStructure === 'Otro' ? 'block' : 'none';
    document.getElementById('asset-legal-structure-otro').value = mp.draft.legalStructureOtro || '';

    // ── Mostrar solo las preguntas que aplican a este tipo de activo ──
    const pensional = esPensional(sub);
    const esUsoPersonal = cat === 'Uso Personal';
    // "¿A nombre de quién está?" no aplica a bienes de uso personal (carro, joyas), a
    // productos pensionales (son individuales) ni al efectivo físico (no tiene titularidad).
    const legalField = document.getElementById('legal-structure-field');
    const ocultaLegal = esUsoPersonal || pensional || sub === 'Efectivo en caja';
    if (legalField) legalField.style.display = ocultaLegal ? 'none' : 'block';
    if (ocultaLegal) {
        mp.draft.legalStructure = 'Propiedad Directa';
        const legalSel = document.getElementById('asset-legal-structure');
        if (legalSel) legalSel.value = 'Propiedad Directa';
        if (legalOtroField) legalOtroField.style.display = 'none';
    }
    if (pensional) { mp.draft.esCompartido = false; mp.draft.porcentajePropio = 100; mp.draft.restringidoLegal = false; }
    // "¿Es solo tuyo o lo compartes?" no aplica a productos pensionales (son individuales).
    const compartidoField = document.getElementById('compartido-field');
    if (compartidoField) compartidoField.style.display = pensional ? 'none' : 'block';
    // "Restricción legal (embargo, sucesión…)" no aplica a productos pensionales: son
    // inembargables por ley y no entran en sucesión (van directo a beneficiarios).
    const restriccionField = document.getElementById('restriccion-field');
    if (restriccionField) restriccionField.style.display = pensional ? 'none' : 'block';

    // Condiciones del activo: compartido y restricción legal
    renderCompartidoBlock();
    const restrChk = document.getElementById('asset-restringido-legal');
    if (restrChk) restrChk.checked = !!mp.draft.restringidoLegal;

    // Empresarial: rol + sector
    const isEmpresarial = cat === 'Empresarial';
    // El sector también aplica a activos financieros ligados a empresas/sectores
    const muestraSector = isEmpresarial || SUBTIPOS_CON_SECTOR.includes(mp.draft.subtype);
    document.getElementById('rol-empresarial-field').style.display = isEmpresarial ? 'block' : 'none';
    document.getElementById('sector-field').style.display = muestraSector ? 'block' : 'none';

    if (muestraSector) {
        // Si no hay sector guardado, sugerir el por defecto del subtipo (editable)
        if (!mp.draft.sector && SECTOR_POR_DEFECTO[mp.draft.subtype]) {
            mp.draft.sector = SECTOR_POR_DEFECTO[mp.draft.subtype];
        }
        document.getElementById('asset-sector').value = mp.draft.sector || '';
        const sectorLabel = document.getElementById('sector-label');
        if (sectorLabel) {
            sectorLabel.textContent = isEmpresarial
                ? '¿Cuál es el sector de la empresa?'
                : '¿En qué sector invierte principalmente? (opcional)';
        }
    }
    // Beneficio tributario: solo para productos que suelen tenerlo
    const subsConBeneficio = ['Fondo de pensiones voluntarias FPV', 'Cuenta AFC', 'Seguro de pensión con ahorro'];
    const btField = document.getElementById('beneficio-tributario-field');
    if (btField) {
        const muestraBT = subsConBeneficio.includes(mp.draft.subtype);
        btField.style.display = muestraBT ? 'block' : 'none';
        if (muestraBT) {
            document.getElementById('asset-beneficio-tributario').checked = !!mp.draft.beneficioTributario;
        }
    }
    const vcField = document.getElementById('vigencia-cumplida-field');
    if (vcField) {
        const muestraVC = (mp.draft.subtype === 'Seguro de pensión con ahorro');
        vcField.style.display = muestraVC ? 'block' : 'none';
        if (muestraVC) document.getElementById('asset-vigencia-cumplida').checked = !!mp.draft.vigenciaCumplida;
    }
    const repField = document.getElementById('reparto-field');
    if (repField) {
        const muestraRep = SUBTIPOS_REPARTO.includes(mp.draft.subtype);
        repField.style.display = muestraRep ? 'block' : 'none';
        if (muestraRep) {
            const val = mp.draft.reparto || '';
            repField.querySelectorAll('input[name="asset-reparto"]').forEach(r => { r.checked = (r.value === val); });
            repField.querySelectorAll('.radio-option').forEach(o => o.classList.toggle('selected', o.dataset.reparto === val));
        }
    }
    const fpvField = document.getElementById('fpv-detalle-field');
    if (fpvField) {
        const muestraFPV = (mp.draft.subtype === 'Fondo de pensiones voluntarias FPV');
        fpvField.style.display = muestraFPV ? 'block' : 'none';
        if (muestraFPV) {
            document.getElementById('asset-fpv-institucional').checked = !!mp.draft.fpvInstitucional;
            document.getElementById('asset-fpv-permanencia').checked = !!mp.draft.fpvPermanencia;
        }
    }
    if (isEmpresarial) {
        document.getElementById('asset-rol-empresarial').value = mp.draft.rolEmpresarial || '';
        document.getElementById('rol-empresarial-otro-field').style.display = mp.draft.rolEmpresarial === 'Otro' ? 'block' : 'none';
        document.getElementById('asset-rol-empresarial-otro').value = mp.draft.rolEmpresarialOtro || '';
    } else {
        document.getElementById('rol-empresarial-otro-field').style.display = 'none';
    }

    const empBlock = document.getElementById('emp-income-block');
    const genericBlock = document.getElementById('generic-income-block');
    if (isEmpresarial) {
        empBlock.style.display = 'block';
        genericBlock.style.display = 'none';
        renderEmpRetiroBlock();
    } else {
        empBlock.style.display = 'none';
        const cfg = INGRESOS_CONFIG[sub];
        if (!cfg || cfg.type === 'none') {
            genericBlock.style.display = 'none';
        } else {
            genericBlock.style.display = 'block';
            renderGenericIncomeBlock(cfg);
        }
    }
}

function renderCompartidoBlock() {
    const yesno = document.getElementById('asset-comparte');
    const pctField = document.getElementById('asset-porcentaje-field');
    if (!yesno || !pctField) return;
    const esCompartido = !!mp.draft.esCompartido;
    yesno.querySelectorAll('.yesno-option').forEach(opt => {
        opt.classList.toggle('selected',
            (opt.dataset.comparte === 'si') === esCompartido);
    });
    pctField.style.display = esCompartido ? 'block' : 'none';
    if (esCompartido) {
        const pct = (mp.draft.porcentajePropio != null && mp.draft.porcentajePropio < 100)
            ? mp.draft.porcentajePropio : '';
        document.getElementById('asset-porcentaje').value = pct;
    }
}

function renderEmpRetiroBlock() {
    const list = document.getElementById('emp-retiro-list');
    list.querySelectorAll('.radio-option').forEach(opt => {
        opt.classList.toggle('selected', mp.draft.empRetiro === opt.dataset.retiro);
    });
    const showSalario = mp.draft.empRetiro === 'salario' || mp.draft.empRetiro === 'mixto';
    const showUtil = mp.draft.empRetiro === 'utilidades' || mp.draft.empRetiro === 'mixto';
    document.getElementById('emp-salario-detail').style.display = showSalario ? 'block' : 'none';
    document.getElementById('emp-utilidades-detail').style.display = showUtil ? 'block' : 'none';
    if (showSalario) setNumberValue(document.getElementById('asset-emp-salario'), mp.draft.empSalarioMensual);
    if (showUtil) {
        setNumberValue(document.getElementById('asset-emp-utilidades'), mp.draft.empUtilidadesAnual);
        document.getElementById('asset-emp-utilidades-freq').value = mp.draft.empUtilidadesFreq || 'irregular';
    }
}

function renderGenericIncomeBlock(cfg) {
    document.getElementById('income-q-label').textContent = cfg.q;
    document.getElementById('income-q-hint').innerHTML = cfg.hint || '';
    const yesno = document.getElementById('income-yesno');
    const rendim = document.getElementById('income-rendimientos');
    const amountDetail = document.getElementById('income-amount-detail');
    const amountLabel = document.getElementById('income-amount-label');
    if (cfg.type === 'binario') {
        yesno.style.display = 'grid';
        rendim.style.display = 'none';
        document.getElementById('income-no-label').textContent = cfg.noLabel || 'No';
        document.getElementById('income-si-label').textContent = cfg.siLabel || 'Sí';
        yesno.querySelectorAll('.yesno-option').forEach(opt => {
            opt.classList.toggle('selected', mp.draft.hasIncome === opt.dataset.income);
        });
        if (mp.draft.hasIncome === 'si') {
            amountDetail.style.display = 'block';
            amountLabel.textContent = cfg.amountLabel || 'Ingreso mensual aproximado';
            setNumberValue(document.getElementById('asset-monthly-income'), mp.draft.monthlyIncome);
        } else {
            amountDetail.style.display = 'none';
        }
    } else if (cfg.type === 'rendimientos') {
        yesno.style.display = 'none';
        rendim.style.display = 'grid';
        rendim.querySelectorAll('.radio-option').forEach(opt => {
            opt.classList.toggle('selected', mp.draft.incomeRendimientos === opt.dataset.rend);
        });
        const showAmount = mp.draft.incomeRendimientos === 'retiro' || mp.draft.incomeRendimientos === 'parcial';
        amountDetail.style.display = showAmount ? 'block' : 'none';
        if (showAmount) {
            amountLabel.textContent = '¿Cuánto recibes en efectivo al mes aproximadamente?';
            setNumberValue(document.getElementById('asset-monthly-income'), mp.draft.monthlyIncome);
        }
    }
}

// Pasos visibles del asistente. El paso 4 (deuda) se omite cuando no aplica: en productos
// pensionales (inembargables) y en dinero líquido o por cobrar (no se dan en garantía).
function pasosVisibles() {
    const deudaAplica = aplicaDeuda(mp.draft.subtype);
    return [1, 2, 3, (deudaAplica ? 4 : null), 5].filter(function(x){ return x !== null; });
}

function renderWizardState() {
    const pasos = pasosVisibles();
    const totalSteps = pasos.length;
    const idxActual = pasos.indexOf(mp.currentStep) + 1;
    document.getElementById('step-indicator').textContent = `Paso ${idxActual} de ${totalSteps}`;
    document.getElementById('progress-fill').style.width = (idxActual / totalSteps * 100) + '%';
    document.querySelectorAll('.modal-step').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.step) === mp.currentStep);
    });
    if (mp.currentStep === 1) renderCategoryGrid();
    if (mp.currentStep === 2) renderSubtypeList();
    if (mp.currentStep === 3) renderStep3();
    if (mp.currentStep === 4) renderStep4();
    if (mp.currentStep === 5) renderStep5();

    ['asset-value', 'asset-monthly-income', 'asset-emp-salario', 'asset-emp-utilidades', 'new-debt-saldo', 'asset-valor-compra']
        .forEach(id => { const el = document.getElementById(id); if (el) attachNumberFormat(el); });

    document.getElementById('btn-back').style.visibility = mp.currentStep === 1 ? 'hidden' : 'visible';
    const isLast = mp.currentStep === 5;
    const nextBtn = document.getElementById('btn-next');
    nextBtn.innerHTML = isLast
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Guardar activo`
        : `Siguiente <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
}

// Muestra un mensaje de error, desplaza la vista hasta él y enfoca el campo indicado.
function focusError(errId, fieldId) {
    const errEl = document.getElementById(errId);
    if (errEl) errEl.classList.add('show');
    // Elemento al que desplazar: el campo si se indicó, si no el propio mensaje
    const target = (fieldId && document.getElementById(fieldId)) || errEl;
    if (target && target.scrollIntoView) {
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) { target.scrollIntoView(); }
    }
    // Enfocar el campo si es un input/select/textarea
    if (fieldId) {
        const f = document.getElementById(fieldId);
        if (f && typeof f.focus === 'function') {
            setTimeout(() => { try { f.focus({ preventScroll: true }); } catch(e) { f.focus(); } }, 300);
        }
    }
    return false;
}

function validateCurrentStep() {
    clearErrors();
    if (mp.currentStep === 1) {
        if (!mp.draft.category) { return focusError('err-category', 'category-grid'); }
    }
    if (mp.currentStep === 2) {
        if (!mp.draft.subtype) { return focusError('err-subtype', 'subtype-list'); }
    }
    if (mp.currentStep === 3) {
        const desc = document.getElementById('asset-description').value.trim();
        const val = getNumberValue(document.getElementById('asset-value'));
        if (!desc) { return focusError('err-value', 'asset-description'); }
        if (val <= 0) { return focusError('err-value', 'asset-value'); }
        mp.draft.description = desc;
        mp.draft.which = document.getElementById('asset-which').value.trim();
        mp.draft.currency = document.getElementById('asset-currency').value;
        mp.draft.value = val;

        // Campos de valorización/proyección (según comportamiento del subtipo)
        const sub = findSubtype(mp.draft.category, mp.draft.subtype);
        const comp = (sub && sub.comp) ? sub.comp : 'estable';

        // Tasa conocida (CDT, cuenta alto rendimiento, bonos)
        if (comp === 'tasa') {
            const tasaRaw = (document.getElementById('asset-tasa').value || '').replace(',', '.').trim();
            const tasaPct = parseFloat(tasaRaw);
            mp.draft.tasaRendimiento = (isFinite(tasaPct) && tasaPct > 0) ? (tasaPct / 100) : 0;
        } else {
            mp.draft.tasaRendimiento = 0;
        }

        // Compra + año (mercado y volátil)
        if (comp === 'mercado' || comp === 'volatil') {
            mp.draft.valorAdquisicion = getNumberValue(document.getElementById('asset-valor-compra')) || 0;
            const anioRaw = parseInt((document.getElementById('asset-anio-compra').value || '').trim(), 10);
            const anioActual = new Date().getFullYear();
            mp.draft.anioAdquisicion = (isFinite(anioRaw) && anioRaw >= 1950 && anioRaw <= anioActual) ? anioRaw : null;
        } else {
            mp.draft.valorAdquisicion = 0;
            mp.draft.anioAdquisicion = null;
        }
    }
    if (mp.currentStep === 4) {
        if (mp.draft.hasDebt === null) { return focusError('err-debt', 'debt-detail'); }
        if (mp.draft.hasDebt === 'si') {
            if (!Array.isArray(mp.draft.deudasVinculadas) || mp.draft.deudasVinculadas.length === 0) {
                document.getElementById('err-debt').textContent = 'Selecciona al menos una deuda, o crea una nueva. Si no tiene deuda, marca "No tiene deuda".';
                return focusError('err-debt', 'debt-link-list');
            }
        } else {
            mp.draft.deudasVinculadas = [];
        }
    }
    if (mp.currentStep === 5) {
        mp.draft.location = document.getElementById('asset-location').value;
        mp.draft.legalStructure = document.getElementById('asset-legal-structure').value;
        mp.draft.legalStructureOtro = mp.draft.legalStructure === 'Otro'
            ? document.getElementById('asset-legal-structure-otro').value.trim()
            : '';

        // Condiciones del activo: porcentaje propio y restricción legal
        if (mp.draft.esCompartido) {
            const pctRaw = (document.getElementById('asset-porcentaje').value || '').replace(',', '.').trim();
            const pct = parseFloat(pctRaw);
            mp.draft.porcentajePropio = (isFinite(pct) && pct > 0 && pct <= 100) ? pct : 100;
        } else {
            mp.draft.porcentajePropio = 100;
        }
        mp.draft.restringidoLegal = !!document.getElementById('asset-restringido-legal').checked;

        if (mp.draft.category === 'Empresarial') {
            mp.draft.rolEmpresarial = document.getElementById('asset-rol-empresarial').value;
            if (!mp.draft.rolEmpresarial) {
                document.getElementById('err-final').textContent = 'Selecciona tu rol en la empresa.';
                return focusError('err-final', 'asset-rol-empresarial');
            }
            mp.draft.rolEmpresarialOtro = mp.draft.rolEmpresarial === 'Otro'
                ? document.getElementById('asset-rol-empresarial-otro').value.trim() : '';

            mp.draft.sector = document.getElementById('asset-sector').value;
            if (!mp.draft.sector) {
                document.getElementById('err-final').textContent = 'Selecciona el sector de la empresa.';
                return focusError('err-final', 'asset-sector');
            }
            if (!mp.draft.empRetiro) {
                document.getElementById('err-final').textContent = 'Indica cómo retiras dinero de la empresa.';
                return focusError('err-final', 'asset-emp-retiro-group');
            }
            mp.draft.empSalarioMensual = (mp.draft.empRetiro === 'salario' || mp.draft.empRetiro === 'mixto')
                ? getNumberValue(document.getElementById('asset-emp-salario')) : 0;
            if (mp.draft.empRetiro === 'utilidades' || mp.draft.empRetiro === 'mixto') {
                mp.draft.empUtilidadesAnual = getNumberValue(document.getElementById('asset-emp-utilidades'));
                mp.draft.empUtilidadesFreq = document.getElementById('asset-emp-utilidades-freq').value;
            } else {
                mp.draft.empUtilidadesAnual = 0;
            }
        } else {
            const cfg = INGRESOS_CONFIG[mp.draft.subtype];
            if (cfg && cfg.type === 'binario') {
                if (mp.draft.hasIncome === null) {
                    document.getElementById('err-final').textContent = 'Indica si genera ingreso o no.';
                    return focusError('err-final', 'income-yesno');
                }
                mp.draft.monthlyIncome = mp.draft.hasIncome === 'si'
                    ? getNumberValue(document.getElementById('asset-monthly-income')) : 0;
            } else if (cfg && cfg.type === 'rendimientos') {
                if (!mp.draft.incomeRendimientos) {
                    document.getElementById('err-final').textContent = 'Indica qué pasa con los rendimientos.';
                    return focusError('err-final', 'income-rendimientos');
                }
                mp.draft.monthlyIncome = (mp.draft.incomeRendimientos === 'retiro' || mp.draft.incomeRendimientos === 'parcial')
                    ? getNumberValue(document.getElementById('asset-monthly-income')) : 0;
            } else {
                mp.draft.monthlyIncome = 0;
            }

            // Sector para activos financieros ligados a empresas (opcional, no bloquea)
            if (SUBTIPOS_CON_SECTOR.includes(mp.draft.subtype)) {
                const selSector = document.getElementById('asset-sector');
                mp.draft.sector = selSector ? selSector.value : '';
            }
        }

        // Beneficio tributario (solo para subtipos que lo muestran)
        const subsConBeneficio = ['Fondo de pensiones voluntarias FPV', 'Cuenta AFC', 'Seguro de pensión con ahorro'];
        if (subsConBeneficio.includes(mp.draft.subtype)) {
            const bt = document.getElementById('asset-beneficio-tributario');
            mp.draft.beneficioTributario = bt ? !!bt.checked : false;
        } else {
            mp.draft.beneficioTributario = false;
        }

        // Vigencia cumplida (solo seguro de pensión con ahorro)
        if (mp.draft.subtype === 'Seguro de pensión con ahorro') {
            const vc = document.getElementById('asset-vigencia-cumplida');
            mp.draft.vigenciaCumplida = vc ? !!vc.checked : false;
        } else {
            mp.draft.vigenciaCumplida = false;
        }

        // Reparto: ¿en una sola empresa o en muchas? (solo inversiones que lo muestran)
        if (SUBTIPOS_REPARTO.includes(mp.draft.subtype)) {
            const repSel = document.querySelector('input[name="asset-reparto"]:checked');
            mp.draft.reparto = repSel ? repSel.value : '';
        } else {
            mp.draft.reparto = '';
        }

        // FPV: plan institucional y pacto de permanencia (solo FPV)
        if (mp.draft.subtype === 'Fondo de pensiones voluntarias FPV') {
            const inst = document.getElementById('asset-fpv-institucional');
            const perm = document.getElementById('asset-fpv-permanencia');
            mp.draft.fpvInstitucional = inst ? !!inst.checked : false;
            mp.draft.fpvPermanencia = perm ? !!perm.checked : false;
        } else {
            mp.draft.fpvInstitucional = false;
            mp.draft.fpvPermanencia = false;
        }
    }
    return true;
}

function goNext() {
    if (!validateCurrentStep()) return;
    if (mp.currentStep === 5) { saveDraft(); return; }
    const pasos = pasosVisibles();
    const i = pasos.indexOf(mp.currentStep);
    mp.currentStep = pasos[Math.min(i + 1, pasos.length - 1)];
    renderWizardState();
    document.querySelector('.modal-body').scrollTop = 0;
}
function goBack() {
    if (mp.currentStep === 1) return;
    const pasos = pasosVisibles();
    const i = pasos.indexOf(mp.currentStep);
    mp.currentStep = pasos[Math.max(i - 1, 0)];
    renderWizardState();
    clearErrors();
    document.querySelector('.modal-body').scrollTop = 0;
}

function saveDraft() {
    const d = mp.draft;
    // Sin deuda vinculada cuando el paso de deuda no aplica (pensionales y dinero líquido/por cobrar).
    if (!aplicaDeuda(d.subtype)) { d.hasDebt = 'no'; d.deudasVinculadas = []; }
    const subInfo = findSubtype(d.category, d.subtype);
    let monthlyIncomeFinal = 0;
    if (d.category === 'Empresarial') {
        monthlyIncomeFinal = (d.empSalarioMensual || 0) + ((d.empUtilidadesAnual || 0) / 12);
    } else {
        monthlyIncomeFinal = d.monthlyIncome || 0;
    }
    const asset = {
        id: d.id,
        category: d.category,
        subtype: d.subtype,
        description: d.description,
        which: d.which || '',
        currency: d.currency,
        value: d.value,
        deudasVinculadas: Array.isArray(d.deudasVinculadas) ? d.deudasVinculadas.slice() : [],
        location: d.location,
        legalStructure: d.legalStructure,
        legalStructureOtro: d.legalStructureOtro || '',
        liquidity: (subInfo && subInfo.liquidez) || 'Media',
        generatesIncome: monthlyIncomeFinal > 0,
        monthlyIncome: monthlyIncomeFinal,
        sector: d.sector || '',
        rolEmpresarial: d.rolEmpresarial || '',
        rolEmpresarialOtro: d.rolEmpresarialOtro || '',
        empRetiro: d.empRetiro || '',
        empSalarioMensual: d.empSalarioMensual || 0,
        empUtilidadesAnual: d.empUtilidadesAnual || 0,
        empUtilidadesFreq: d.empUtilidadesFreq || '',
        incomeRendimientos: d.incomeRendimientos || '',
        hasIncome: d.hasIncome || '',
        tasaRendimiento: d.tasaRendimiento || 0,
        valorAdquisicion: d.valorAdquisicion || 0,
        anioAdquisicion: d.anioAdquisicion || null,
        tasaDepreciacion: d.tasaDepreciacion || 0,
        beneficioTributario: !!d.beneficioTributario,
        vigenciaCumplida: !!d.vigenciaCumplida,
        reparto: d.reparto || '',
        fpvInstitucional: !!d.fpvInstitucional,
        fpvPermanencia: !!d.fpvPermanencia,
        esCompartido: !!d.esCompartido,
        porcentajePropio: (d.porcentajePropio != null ? d.porcentajePropio : 100),
        restringidoLegal: !!d.restringidoLegal,
        _sourceFormat: 'mapa-autoservicio-v4',
        _updatedAt: new Date().toISOString(),
    };
    if (mp.editingId) {
        const idx = mp.assets.findIndex(a => a.id === mp.editingId);
        if (idx >= 0) mp.assets[idx] = asset;
    } else {
        mp.assets.push(asset);
    }
    mpSave();
    closeAssetModal();
    renderInventory();
    showToast(mp.editingId ? 'Activo actualizado' : 'Activo agregado correctamente');
}

function editAsset(id) { openAssetModal(id); }
function deleteAsset(id) {
    const asset = mp.assets.find(a => a.id === id);
    if (!asset) return;
    host.confirm({
        title: 'Eliminar activo',
        msg: `¿Eliminar "${asset.description}" de tu mapa patrimonial?`,
        confirmText: 'Eliminar', cancelText: 'Cancelar', danger: true,
        onConfirm: () => {
            mp.assets = mp.assets.filter(a => a.id !== id);
            mpSave();
            renderInventory();
            showToast('Activo eliminado', 'success');
        }
    });
}
window.__editAsset = editAsset;
window.__deleteAsset = deleteAsset;

// Delegado al sistema de toast de la herramienta (host.toast).
function showToast(msg, type) {
    const t = (type === true) ? 'error' : (type || 'success');
    try { host.toast(msg, t); } catch(e) {}
}


  // ════════════════════════════════════════════════════════════════════════════════
  // MIGRACIÓN: activos viejos con `liability` propio -> deuda nueva en el M2
  // Se ejecuta una vez al cargar; convierte cada liability>0 en una deuda del M2
  // y la enlaza al activo. Idempotente: marca el activo con _debtMigrated.
  // ════════════════════════════════════════════════════════════════════════════════
  // ── Migración · Realinear la liquidez con el catálogo ──────────────────
  // La liquidez de un activo NO la elige el usuario: se deriva del subtipo. Cuando el
  // catálogo se corrige (p. ej. el fondo voluntario y la cuenta AFC pasaron a contar como
  // líquidos, y el seguro de pensión dejó de tratarse como un inmueble), los activos ya
  // guardados conservan la clasificación vieja. Esto los pone al día una sola vez.
  // No toca ningún dato que el usuario haya escrito (sector, valores, nombres).
  function migrarLiquidezCatalogo() {
    const cambios = [];
    // La vivienda propia ahora vive solo en la categoría Inmueble (antes estaba duplicada
    // también en Uso Personal). Reasignamos los activos guardados con la categoría vieja.
    mp.assets.forEach(a => {
      if (a && a.category === 'Uso Personal' && a.subtype === 'Casa o apartamento donde vivo') {
        a.category = 'Inmueble';
      }
    });
    mp.assets.forEach(a => {
      if (!a || a.linkedToFondo || a.linkedToProvisiones) return;   // filas sincronizadas del M4: no son del mapa
      const s = findSubtype(a.category, a.subtype);
      if (!s || !s.liquidez) return;                                // subtipo fuera del catálogo: no se toca
      if (a.liquidity === s.liquidez) return;                       // ya está al día
      cambios.push({ activo: a.description || a.subtype || a.category, de: a.liquidity || '(sin dato)', a: s.liquidez });
      a.liquidity = s.liquidez;
    });
    if (cambios.length) {
      mpSave();
      try { console.log('ABBA · liquidez actualizada según el catálogo en ' + cambios.length + ' activo(s):', cambios); } catch(e) {}
      try { showToast('Actualizamos la liquidez de ' + cambios.length + ' activo' + (cambios.length>1?'s':'') + ' con la clasificación más reciente.', 'info'); } catch(e) {}
    }
    return cambios.length;
  }

  function migrateLegacyLiabilities() {
    let migrated = 0;
    mp.assets.forEach(a => {
      if (a._debtMigrated) return;
      const legacy = a.liability || 0;
      if (legacy > 0) {
        // El saldo del M2 va en COP
        let saldoCOP = legacy;
        if (a.currency && a.currency !== 'COP') {
          const conv = convertirACOP(legacy, a.currency);
          saldoCOP = isFinite(conv) ? conv : legacy;
        }
        const nombre = 'Deuda de ' + (a.description || a.category || 'activo');
        const newId = host.createDeuda({
          nombre,
          saldo: saldoCOP,
          tipoMapa: a.debtType || '',
          categoriaActivo: a.category,
          origenMapa: true,
        });
        if (newId) {
          a.deudasVinculadas = Array.isArray(a.deudasVinculadas) ? a.deudasVinculadas : [];
          a.deudasVinculadas.push(newId);
          migrated++;
        }
      }
      // Limpiar campos viejos y marcar migrado
      a._debtMigrated = true;
      delete a.liability;
      delete a.debtType;
      delete a.debtTypeOtro;
      if (!Array.isArray(a.deudasVinculadas)) a.deudasVinculadas = [];
    });
    if (migrated > 0) { mpSave(); }
    return migrated;
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // LISTENERS DEL WIZARD  (sin auth — la herramienta ya autentica)
  // ════════════════════════════════════════════════════════════════════════════════
  let listenersBound = false;
  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;

    const byId = (id) => document.getElementById(id);
    const on = (id, ev, fn) => { const el = byId(id); if (el) el.addEventListener(ev, fn); };

    on('btn-add-first', 'click', () => openAssetModal());
    on('btn-add-more', 'click', () => openAssetModal());
    on('mp-add-asset', 'click', () => openAssetModal());
    on('btn-next', 'click', goNext);
    on('btn-back', 'click', goBack);
    on('modal-close', 'click', () => {
      host.confirm({ title:'¿Cerrar sin guardar?', msg:'Perderás lo que llevas de este activo.', confirmText:'Cerrar', cancelText:'Seguir editando', danger:true, onConfirm: closeAssetModal });
    });
    on('asset-modal', 'click', (e) => {
      if (e.target.id === 'asset-modal') {
        host.confirm({ title:'¿Cerrar sin guardar?', msg:'Perderás lo que llevas de este activo.', confirmText:'Cerrar', cancelText:'Seguir editando', danger:true, onConfirm: closeAssetModal });
      }
    });

    on('asset-currency', 'change', () => {
      if (mp.draft) mp.draft.currency = byId('asset-currency').value;
      updateCurrencyPrefix();
      updateValueCOPDisplay();
    });
    on('asset-value', 'input', updateValueCOPDisplay);

    // Botón crear-deuda nueva (mini-formulario, opción B)
    on('new-debt-toggle', 'click', () => {
      const nf = byId('new-debt-form');
      if (nf) nf.style.display = nf.style.display === 'none' ? 'block' : 'none';
    });
    on('new-debt-save', 'click', createAndLinkDebt);

    document.addEventListener('click', (e) => {
      const debtOpt = e.target.closest('.yesno-option[data-debt]');
      if (debtOpt && mp.draft) {
        mp.draft.hasDebt = debtOpt.dataset.debt;
        renderStep4();
        clearErrors();
      }
      const incomeOpt = e.target.closest('.yesno-option[data-income]');
      if (incomeOpt && mp.draft) {
        mp.draft.hasIncome = incomeOpt.dataset.income;
        renderStep5();
        clearErrors();
      }
      const comparteOpt = e.target.closest('.yesno-option[data-comparte]');
      if (comparteOpt && mp.draft) {
        mp.draft.esCompartido = comparteOpt.dataset.comparte === 'si';
        if (!mp.draft.esCompartido) mp.draft.porcentajePropio = 100;
        renderCompartidoBlock();
      }
      const retiroOpt = e.target.closest('.radio-option[data-retiro]');
      if (retiroOpt && mp.draft) {
        mp.draft.empRetiro = retiroOpt.dataset.retiro;
        renderEmpRetiroBlock();
        clearErrors();
      }
      const rendOpt = e.target.closest('.radio-option[data-rend]');
      if (rendOpt && mp.draft) {
        mp.draft.incomeRendimientos = rendOpt.dataset.rend;
        const cfg = INGRESOS_CONFIG[mp.draft.subtype];
        if (cfg) renderGenericIncomeBlock(cfg);
        clearErrors();
      }
      // Checkbox de enlace de deuda del M2
      const linkChk = e.target.closest('.debt-link-check');
      if (linkChk && mp.draft) {
        const id = linkChk.dataset.deudaId;
        if (!Array.isArray(mp.draft.deudasVinculadas)) mp.draft.deudasVinculadas = [];
        if (linkChk.checked) {
          if (!mp.draft.deudasVinculadas.includes(id)) mp.draft.deudasVinculadas.push(id);
        } else {
          mp.draft.deudasVinculadas = mp.draft.deudasVinculadas.filter(x => x !== id);
        }
        updateNetWorthPreview();
        clearErrors();
      }
    });

    on('asset-legal-structure', 'change', (e) => {
      if (!mp.draft) return;
      mp.draft.legalStructure = e.target.value;
      byId('legal-structure-otro-field').style.display = e.target.value === 'Otro' ? 'block' : 'none';
    });
    on('asset-rol-empresarial', 'change', (e) => {
      if (!mp.draft) return;
      mp.draft.rolEmpresarial = e.target.value;
      byId('rol-empresarial-otro-field').style.display = e.target.value === 'Otro' ? 'block' : 'none';
    });
    on('asset-sector', 'change', (e) => { if (mp.draft) mp.draft.sector = e.target.value; });

    document.addEventListener('keydown', (e) => {
      const modal = byId('asset-modal');
      if (!modal || !modal.classList.contains('open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        host.confirm({ title:'¿Cerrar sin guardar?', msg:'Perderás lo que llevas de este activo.', confirmText:'Cerrar', cancelText:'Seguir editando', danger:true, onConfirm: closeAssetModal });
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // API PÚBLICA DEL MÓDULO
  // ════════════════════════════════════════════════════════════════════════════════
  function init(opts) {
    // Cablear el contrato con la herramienta
    if (opts && opts.host) Object.assign(host, opts.host);
    // Cargar datos del mapa (vienen de la herramienta)
    if (opts && opts.data) {
      mp.trm = opts.data.trm || {};
      mp.assets = Array.isArray(opts.data.activos) ? opts.data.activos : [];
    }
    bindListeners();
    migrateLegacyLiabilities();
    migrarLiquidezCatalogo();
    renderInventory();
  }

  function setData(data) {
    mp.trm = (data && data.trm) || {};
    mp.assets = (data && Array.isArray(data.activos)) ? data.activos : [];
    migrarLiquidezCatalogo();
    renderInventory();
  }

  function refresh() { renderInventory(); }  // re-render (p.ej. tras cambios en el M2)

  return {
    init,
    setData,
    refresh,
    getData: getExportData,
    onChange: (cb) => { if (typeof cb === 'function') changeListeners.push(cb); },
  };

  })(); // fin IIFE MapaPatrimonial
  window.MapaPatrimonial = MapaPatrimonial;

  
  /* ═══════════════════════════════════════════════════════════
     HELPERS — formato y parseo
     ═══════════════════════════════════════════════════════════ */
  function escapeHtml(str){
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  const n = v => {
    if (v == null || v === '') return 0;
    const s = String(v).replace(/[^\d-]/g,'');
    return parseInt(s,10) || 0;
  };
  const fmt = v => {
    if (v == null || isNaN(v)) return currency + ' 0';
    return currency + ' ' + Math.round(Number(v)).toLocaleString('es-CO');
  };
  const fmtNum = v => {
    if (v == null || isNaN(v)) return '0';
    return Math.round(Number(v)).toLocaleString('es-CO');
  };
  const fmtInput = v => {
    // formato compacto sin moneda para inputs
    if (v == null || v === 0 || isNaN(v)) return '';
    return Math.round(Number(v)).toLocaleString('es-CO');
  };
  const pct = v => isNaN(v) ? '0%' : (v*100).toFixed(1) + '%';
  
  /* Money input: format as user types, preserve cursor */
  function attachMoneyInput(input){
    if(input.dataset.money) return;
    input.dataset.money='1';
    input.type='text';
    input.inputMode='numeric';
    input.autocomplete='off';
    input.addEventListener('input', function(e){
      const before = this.value;
      const cursor = this.selectionStart;
      // count digits before cursor
      const digitsBefore = (before.slice(0,cursor).match(/\d/g)||[]).length;
      const digitsOnly = before.replace(/\D/g,'');
      const cleaned = digitsOnly.replace(/^0+(\d)/,'$1');
      const formatted = cleaned ? Number(cleaned).toLocaleString('es-CO') : '';
      this.value = formatted;
      // restore cursor
      let pos = 0, count = 0;
      while(pos < formatted.length && count < digitsBefore){
        if(/\d/.test(formatted[pos])) count++;
        pos++;
      }
      this.setSelectionRange(pos,pos);
    });
    input.addEventListener('focus', function(){
      if(this.value === '') return;
      setTimeout(()=>this.select(),0);
    });
    input.addEventListener('blur', function(){
      const val = n(this.value);
      this.value = val ? fmtInput(val) : '';
    });
  }
  
  /* SVG icons */
  const SVG_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>`;
  const SVG_WARN  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const SVG_INFO  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  const SVG_X     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const SVG_LIST  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="3.6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>`;
  const SVG_TARGET= `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`;
  
  function debtGroup(val){const dt=DEBT_TYPES.find(d=>d.val===val);return dt?dt.group:'otro';}
  function debtTypeOptions(selected='CONSUMO_TARJETA'){
    return DEBT_TYPES.map(d=>`<option value="${d.val}" ${d.val===selected?'selected':''}>${d.label}</option>`).join('');
  }
  
  /* Toast */
  function showToast(msg,type='info'){
    const icons={success:SVG_CHECK,error:SVG_WARN,info:SVG_INFO};
    const c=document.getElementById('toast-wrap');
    const t=document.createElement('div');
    t.className='toast '+type;
    t.innerHTML=`${icons[type]||SVG_INFO}<span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(()=>{t.style.animation='slideUp .3s ease forwards';setTimeout(()=>t.remove(),300);},2800);
  }
  function showModal(title,msg){
    document.getElementById('modal-title').textContent=title;
    document.getElementById('modal-msg').textContent=msg;
    document.getElementById('modal-overlay').classList.add('show');
  }
  function closeModal(){document.getElementById('modal-overlay').classList.remove('show');}

  /* Modal de confirmación con diseño consistente (reemplaza confirm() nativo).
     opts: {title, msg, confirmText, cancelText, danger, onConfirm, onCancel} */
  function showConfirm(opts){
    opts = opts || {};
    const ov = document.getElementById('confirm-overlay');
    if(!ov){ if(window.confirm(opts.msg||'¿Confirmar?')){ if(opts.onConfirm) opts.onConfirm(); } return; }
    document.getElementById('confirm-title').textContent = opts.title || '¿Confirmar?';
    document.getElementById('confirm-msg').textContent   = opts.msg || '';
    let okBtn = document.getElementById('confirm-ok');
    let cancelBtn = document.getElementById('confirm-cancel');
    okBtn.textContent = opts.confirmText || 'Confirmar';
    cancelBtn.textContent = opts.cancelText || 'Cancelar';
    okBtn.classList.toggle('btn-modal-danger', !!opts.danger);
    // Clonar para limpiar listeners de invocaciones previas
    const okNew = okBtn.cloneNode(true); okBtn.parentNode.replaceChild(okNew, okBtn);
    const cancelNew = cancelBtn.cloneNode(true); cancelBtn.parentNode.replaceChild(cancelNew, cancelBtn);
    function close(){ ov.classList.remove('show'); }
    okNew.addEventListener('click', function(){ close(); if(opts.onConfirm) opts.onConfirm(); });
    cancelNew.addEventListener('click', function(){ close(); if(opts.onCancel) opts.onCancel(); });
    ov.classList.add('show');
  }
  function toggleAcc(h){h.parentElement.classList.toggle('open');}
  
  function navigateTo(num){
    document.querySelectorAll('.module').forEach(m=>m.classList.remove('active'));
    document.querySelectorAll('.sb-item, .bb-item').forEach(n=>n.classList.remove('active'));
    const id = isNaN(num) ? num : parseInt(num);
    document.getElementById('modulo-'+id).classList.add('active');
    document.querySelectorAll(`[data-module="${id}"]`).forEach(el=>el.classList.add('active'));
    document.getElementById('topbar-title').textContent = MODULE_TITLES[id] || '';
    // Re-render desde el estado vivo: los cambios de cualquier módulo se reflejan
    // al entrar a otro, sin necesidad de guardar.
    if(id===1){renderIngresosTable();renderGastosTable('gastos-body');calcM1();}
    if(id===2){calcM2();}
    if(id===3){renderActivosTable();calcM3();}
    if(id===4){renderAhorroTable();calcM4();}
    if(id===5){renderP5Deudas();calcP5Totals();}
    if(id===6){renderTablero();renderCharts();renderDashboardPatrimonio();renderDashboardRiesgo();renderDashboardIngresos();}
    if(id===7){renderDebtSim();}
    if(id===8){renderMetas();}
    if(id===9){renderInformeM9();}
    if(id===10){renderPerfilFiscal();}
    if(id===11){renderCentroFiscal();}
    if(id===12){renderPresupuesto();}
    if(id===13){renderEstructuraLegal();}
    if(id===14){renderModulo14();}
    if(id===15){renderCapasTablero();}
    if(id==='var'){renderMVar();}
    window.scrollTo({top:0,behavior:'smooth'});
  }
  
  /* ═══════════════════════════════════════════════════════════
     CALCULATIONS
     ═══════════════════════════════════════════════════════════ */
  function calcM1(){
    let totalIng=0;
    document.querySelectorAll('#ingresos-body .item-row').forEach((r,i)=>{
      if(!state.ingresos[i]) return;
      if(r.classList.contains('item-row-locked')){
        // Línea sincronizada: el monto vive en state, no en input
        totalIng += state.ingresos[i].monto || 0;
      } else {
        const nombreEl = r.querySelector('input[data-f=nombre]');
        const montoEl  = r.querySelector('input[data-f=monto]');
        const v = n(montoEl?.value);
        totalIng += v;
        state.ingresos[i].monto = v;
        if(nombreEl) state.ingresos[i].nombre = nombreEl.value;
      }
    });
    let totalGas=0;
    // El total de cada categoría se deriva de sus items (state.gastos[k] ya está sincronizado).
    Object.values(state.gastos).forEach(v => totalGas += (v||0));
    const pctG = totalIng>0 ? totalGas/totalIng : 0;
    const pctL = 1 - pctG;
    const cls  = pctG<.7 ? 'is-pos' : pctG<=.85 ? 'is-warn' : 'is-neg';
    const tag  = pctG<.7 ? 'pos'    : pctG<=.85 ? 'warn'   : 'neg';
    const tagText = pctG<.7 ? 'Saludable' : pctG<=.85 ? 'Atención' : 'Crítico';
    document.getElementById('m1-kpis').innerHTML = `
      <div class="kpi is-info">
        <div class="kpi-label">Total ingresos</div>
        <div class="kpi-value">${fmt(totalIng)}</div>
        <div class="kpi-sub">Mensual</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total gastos</div>
        <div class="kpi-value">${fmt(totalGas)}</div>
        <div class="kpi-sub">Mensual</div>
      </div>
      <div class="kpi ${cls}">
        <div class="kpi-label">% destinado a gastos</div>
        <div class="kpi-value">${pct(pctG)}</div>
        <div class="kpi-tag ${tag}">${SVG_CHECK}${tagText}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Libre · ahorro y deudas</div>
        <div class="kpi-value">${pct(pctL)}</div>
        <div class="kpi-sub">Del ingreso mensual</div>
      </div>`;
    scheduleSave('ingresos_gastos');
    return {totalIng,totalGas};
  }
  
  function calcM2(){
    const {totalIng}=calcM1();
    let totalDeuda=0,totalPagos=0,sumaPond=0,totConsumo=0,totApal=0,totOtro=0;
    let pagosConsumo=0,pagosApal=0;
    state.deudas=[];
    document.querySelectorAll('#deudas-body .multi-row').forEach(r=>{
      let rowId=r.dataset.id; if(!rowId){ rowId=genDebtId(); r.dataset.id=rowId; }
      const nombre=r.querySelector('input[data-f=nombre]')?.value||'';
      const saldo=n(r.querySelector('input[data-f=saldo]')?.value);
      const cuota=n(r.querySelector('input[data-f=cuota]')?.value);
      const tasa=parseFloat(r.querySelector('input[data-f=tasa]')?.value)/100 || 0;
      const tipo=r.querySelector('select[data-f=tipo]')?.value||'CONSUMO_TARJETA';
      const grupo=debtGroup(tipo);
      totalDeuda+=saldo; totalPagos+=cuota; sumaPond+=saldo*tasa;
      if(grupo==='consumo'){totConsumo+=saldo;pagosConsumo+=cuota;}
      else if(grupo==='apalancamiento'){totApal+=saldo;pagosApal+=cuota;}
      else totOtro+=saldo;
      // Cargos recurrentes: solo tarjetas de crédito
      let cargos=[];
      if(tipo==='CONSUMO_TARJETA'){
        r.querySelectorAll('[data-cargos-list] .deuda-cargo-row').forEach(cr=>{
          const cn=cr.querySelector('[data-cf=nombre]')?.value||'';
          const cm=n(cr.querySelector('[data-cf=monto]')?.value);
          if(cm>0 || cn.trim()) cargos.push({nombre:cn, monto:cm});
        });
      }
      state.deudas.push({id:rowId,nombre,saldo,cuota_mensual:cuota,tasa_anual:tasa,tipo,grupo,cargos});
    });
    syncCargosTarjeta();   // refleja los cargos de tarjeta en la categoría sincronizada de gastos
    const tasaProm     = totalDeuda>0 ? sumaPond/totalDeuda : 0;
    const pctConsumoIng= totalIng>0   ? pagosConsumo/totalIng : 0;
    const pctTotalIng  = totalIng>0   ? totalPagos/totalIng   : 0;
    const ratioConsumo = totalDeuda>0 ? totConsumo/totalDeuda : 0;
    const ratioApal    = totalDeuda>0 ? totApal/totalDeuda    : 0;
    const ratioOtro    = totalDeuda>0 ? totOtro/totalDeuda    : 0;
    const cc = pctConsumoIng<.2 ? 'is-pos' : pctConsumoIng<=.3 ? 'is-warn' : 'is-neg';
    const ct = pctTotalIng<.3   ? 'is-pos' : pctTotalIng<=.4   ? 'is-warn' : 'is-neg';
  
    document.getElementById('m2-kpis').innerHTML = `
      <div class="kpi is-info">
        <div class="kpi-label">Deuda total</div>
        <div class="kpi-value">${fmt(totalDeuda)}</div>
        <div class="kpi-sub">Saldo agregado</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Pagos mensuales</div>
        <div class="kpi-value">${fmt(totalPagos)}</div>
        <div class="kpi-sub">Cuotas totales</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Tasa promedio anual</div>
        <div class="kpi-value">${pct(tasaProm)}</div>
        <div class="kpi-sub">Ponderada por saldo</div>
      </div>
      <div class="kpi ${cc}">
        <div class="kpi-label">% ingreso · deuda consumo</div>
        <div class="kpi-value">${pct(pctConsumoIng)}</div>
        <div class="kpi-tag ${cc==='is-pos'?'pos':cc==='is-warn'?'warn':'neg'}">${cc==='is-pos'?SVG_CHECK:SVG_WARN} Meta &lt;20%</div>
      </div>
      <div class="kpi ${ct} span-2">
        <div class="kpi-label">% ingreso · total deudas</div>
        <div class="kpi-value">${pct(pctTotalIng)}</div>
        <div class="kpi-tag ${ct==='is-pos'?'pos':ct==='is-warn'?'warn':'neg'}">${ct==='is-pos'?SVG_CHECK:SVG_WARN} Meta &lt;30%</div>
      </div>`;
  
    document.getElementById('m2-structure').innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg></div>
          <h3>Estructura de tu deuda</h3>
        </div>
        <div class="structure-grid">
          <div class="struct-card danger">
            <div class="sc-label">Consumo</div>
            <div class="sc-val">${fmt(totConsumo)}</div>
            <div class="sc-sub">${pct(ratioConsumo)} del total · reduce capacidad</div>
            <div class="sc-bar"><div class="sc-bar-fill" style="width:${Math.min(ratioConsumo*100,100)}%;background:var(--neg)"></div></div>
          </div>
          <div class="struct-card success">
            <div class="sc-label">Apalancamiento</div>
            <div class="sc-val">${fmt(totApal)}</div>
            <div class="sc-sub">${pct(ratioApal)} del total · puede generar retorno</div>
            <div class="sc-bar"><div class="sc-bar-fill" style="width:${Math.min(ratioApal*100,100)}%;background:var(--pos)"></div></div>
          </div>
          <div class="struct-card neutral">
            <div class="sc-label">Otras deudas</div>
            <div class="sc-val">${fmt(totOtro)}</div>
            <div class="sc-sub">${pct(ratioOtro)} del total</div>
            <div class="sc-bar"><div class="sc-bar-fill" style="width:${Math.min(ratioOtro*100,100)}%;background:var(--ink-4)"></div></div>
          </div>
        </div>
        <div class="alert ${ratioApal>0.5?'pos':ratioApal>0.25?'warn':'neg'}" style="margin-top:14px">
          ${ratioApal>0.5?SVG_CHECK:SVG_WARN}
          <div><strong>Ratio de apalancamiento: ${(ratioApal*100).toFixed(1)}%.</strong>
          ${ratioApal>0.5?' Tu deuda trabaja mayoritariamente para generar activos.':ratioApal>0.25?' Mezcla equilibrada de consumo y apalancamiento.':' La mayor parte de tu deuda es de consumo. Prioriza pagarla.'}</div>
        </div>
      </div>`;
    scheduleSave('endeudamiento');
    return {totalDeuda,totalPagos,pagosConsumo,totConsumo,totApal,totOtro,ratioConsumo,ratioApal};
  }
  
  function calcM3(){
    let totalActivos=0,totalLiquido=0,totalNoLiquido=0,totalRestringido=0;
    // Preservar filas linked (sincronizadas con MVar) — son fondos disponibles, no restringidos
    const lockedRows = state.activos.filter(a=>a.linkedToFondo || a.linkedToProvisiones);
    state.activos = [...lockedRows];
    lockedRows.forEach(a=>{
      totalActivos += a.valor||0;
      if(a.tipo==='LÍQUIDO') totalLiquido += a.valor||0;
      else totalNoLiquido += a.valor||0;
    });
    // Activos del Mapa Patrimonial (función puente): valor BRUTO en COP + liquidez.
    let mapaData = null;
    try { mapaData = (window.MapaPatrimonial && window.MapaPatrimonial.getData) ? window.MapaPatrimonial.getData() : null; } catch(e){ mapaData=null; }
    const mapaActivos = (mapaData && Array.isArray(mapaData.activosNormalizados)) ? mapaData.activosNormalizados : [];
    mapaActivos.forEach(a=>{
      const valor=a.valor||0;
      totalActivos+=valor;
      if(a.tipo==='LÍQUIDO') totalLiquido+=valor; else totalNoLiquido+=valor;
      if(a.restringido) totalRestringido+=valor;
      state.activos.push({nombre:a.nombre,valor,tipo:a.tipo,restringido:!!a.restringido,_mapaId:a._mapaId});
    });
    const pctL=totalActivos>0?totalLiquido/totalActivos:0;
    const pctNL=totalActivos>0?totalNoLiquido/totalActivos:0;
    const totalDeuda=(state.deudas||[]).reduce((s,d)=>s+(d.saldo||0),0);
    const patrimonioNeto = totalActivos - totalDeuda;
    const patrimonioDisponible = (totalActivos - totalRestringido) - totalDeuda;
    const dispClass = patrimonioDisponible >= 0 ? 'is-pos' : 'is-neg';
    const kpisEl = document.getElementById('m3-kpis');
    if(kpisEl) kpisEl.innerHTML = `
      <div class="kpi is-info span-2">
        <div class="kpi-label">Total activos</div>
        <div class="kpi-value">${fmt(totalActivos)}</div>
        <div class="kpi-sub">Patrimonio bruto</div>
      </div>
      <div class="kpi is-pos">
        <div class="kpi-label">Activos líquidos</div>
        <div class="kpi-value">${fmt(totalLiquido)}</div>
        <div class="kpi-sub">${pct(pctL)} del total</div>
      </div>
      <div class="kpi is-warn">
        <div class="kpi-label">Activos no líquidos</div>
        <div class="kpi-value">${fmt(totalNoLiquido)}</div>
        <div class="kpi-sub">${pct(pctNL)} del total</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Fondos restringidos</div>
        <div class="kpi-value">${fmt(totalRestringido)}</div>
        <div class="kpi-sub">Pensión, cesantías… no disponibles</div>
      </div>
      <div class="kpi ${dispClass} span-2">
        <div class="kpi-label">Patrimonio neto disponible</div>
        <div class="kpi-value">${fmt(patrimonioDisponible)}</div>
        <div class="kpi-sub">Activos disponibles − deudas · neto total ${fmt(patrimonioNeto)}</div>
      </div>`;
    scheduleSave('activos');
    return {totalActivos,totalLiquido,totalNoLiquido,totalRestringido,patrimonioNeto,patrimonioDisponible,pctL,pctNL};
  }
  
  function calcM4(){
    const cuposInp = document.getElementById('m4-cupos');
    if(cuposInp && !cuposInp.dataset.wired){
      cuposInp.dataset.wired = '1';
      attachMoneyInput(cuposInp);
      cuposInp.value = (state.cuposDisponibles||0) ? Number(state.cuposDisponibles).toLocaleString('es-CO') : '';
      cuposInp.addEventListener('input', ()=>{
        state.cuposDisponibles = +(cuposInp.value.replace(/\D/g,'')) || 0;
        scheduleSave('ahorro');
      });
    }
    let totalAhorro=0;
    const linkedRows = state.ahorro.filter(a=>a.linkedToFondoAporte || a.linkedToProvisionesAporte);
    state.ahorro=[];
    let linkedIdx = 0;
    document.querySelectorAll('#ahorro-body .item-row').forEach(r=>{
      const nombre=r.querySelector('input[data-f=nombre]')?.value||'';
      const monto=n(r.querySelector('input[data-f=monto]')?.value);
      totalAhorro+=monto;
      if(r.classList.contains('item-row-suggested') && linkedRows[linkedIdx]){
        state.ahorro.push({...linkedRows[linkedIdx], nombre, monto_mensual:monto});
        linkedIdx++;
      } else {
        const precaucion = r.querySelector('input[data-f=precaucion]')?.checked || false;
        state.ahorro.push({nombre,monto_mensual:monto,precaucion});
      }
    });
    const {totalIng,totalGas}=calcM1();
    const {totalDeuda}=calcM2();
    const {totalActivos,totalLiquido}=calcM3();
    const esPrecaucion = a => a.linkedToFondoAporte || a.linkedToProvisionesAporte || a.precaucion;
    const ahorroPrecaucion = (state.ahorro||[]).filter(esPrecaucion).reduce((s,a)=>s+(a.monto_mensual||0),0);
    const ahorroInversion  = totalAhorro - ahorroPrecaucion;   // "lo demás": ahorro/inversión, sin el colchón de precaución
    const pctAho     = totalIng>0  ? ahorroInversion/totalIng     : 0;
    const solvencia  = totalDeuda>0? totalActivos/totalDeuda  : 0;
    const fondoEmerg = totalGas>0  ? totalLiquido/totalGas    : 0;
    const ca = pctAho>=.2     ? 'is-pos' : pctAho>=.1     ? 'is-warn' : 'is-neg';
    const cs = solvencia>1.5  ? 'is-pos' : solvencia>=1   ? 'is-warn' : 'is-neg';
    const cf = fondoEmerg>6   ? 'is-pos' : fondoEmerg>=3  ? 'is-warn' : 'is-neg';
    document.getElementById('m4-kpis').innerHTML = `
      <div class="kpi is-info span-2">
        <div class="kpi-label">Ahorro/inversión mensual</div>
        <div class="kpi-value">${fmt(ahorroInversion)}</div>
        <div class="kpi-sub">${ahorroPrecaucion>0 ? 'Precaución (colchón) aparte: '+fmt(ahorroPrecaucion)+'/mes' : 'Sin contar colchón de precaución'}</div>
      </div>
      <div class="kpi ${ca}">
        <div class="kpi-label">Capacidad de ahorro</div>
        <div class="kpi-value">${pct(pctAho)}</div>
        <div class="kpi-tag ${ca==='is-pos'?'pos':ca==='is-warn'?'warn':'neg'}">${ca==='is-neg'?SVG_WARN:SVG_CHECK} Meta &gt;10%</div>
      </div>
      <div class="kpi ${cs}">
        <div class="kpi-label">Nivel de solvencia</div>
        <div class="kpi-value">${solvencia.toFixed(2)}×</div>
        <div class="kpi-sub">Activos / Deudas</div>
      </div>
      <div class="kpi ${cf} span-2">
        <div class="kpi-label">Fondo de emergencias</div>
        <div class="kpi-value">${fondoEmerg.toFixed(1)} meses</div>
        <div class="kpi-sub">Meses de gastos cubiertos · meta &gt;6</div>
      </div>`;
    scheduleSave('ahorro');
    return {totalAhorro, ahorroPrecaucion, ahorroInversion};
  }
  
  function calcP5Totals(){
    const readRows = bodyId => {
      let m=0,a=0;
      document.querySelectorAll('#'+bodyId+' .multi-row').forEach(r=>{
        const frec=r.querySelector('select[data-f=frec]')?.value;
        const monto=n(r.querySelector('input[data-f=monto]')?.value);
        if(frec==='TODOS LOS MESES') m+=monto; else a+=monto;
      });
      return {m,a};
    };
    const {m:iM,a:iA} = readRows('p5-ingresos-body');
    const {m:dM,a:dA} = readRows('p5-deudas-body');
    const {m:aM,a:aA} = readRows('p5-ahorro-body');
    let gM=0,gA=0;
    p5Cats().forEach(cat=>{
      const {m,a}=readRows('p5-gas-'+cat.id+'-body');
      gM+=m;gA+=a;
      const eM=document.getElementById('acc-gas-'+cat.id+'-m');
      const eA=document.getElementById('acc-gas-'+cat.id+'-a');
      if(eM) eM.textContent = fmtNum(m)+' mensual';
      if(eA) eA.textContent = fmtNum(a)+' anual';
    });
    document.getElementById('acc-ing-m').textContent = fmtNum(iM)+' mensual';
    document.getElementById('acc-ing-a').textContent = fmtNum(iA)+' anual';
    const m2Mensual=(state.deudas||[]).reduce((s,d)=>s+(d.cuota_mensual||0),0);
    document.getElementById('acc-deu-m').textContent = fmtNum(m2Mensual)+' mensual';
    document.getElementById('acc-deu-a').textContent = fmtNum(dA)+' anual';
    document.getElementById('acc-aho-m').textContent = fmtNum(aM)+' mensual';
    document.getElementById('acc-aho-a').textContent = fmtNum(aA)+' anual';
    // Total mensual de ingresos del M1 (incluye salario personal sincronizado)
    const m1IngresoMensual = (state.ingresos||[]).reduce((sum,ing)=>sum + (ing.monto||0), 0);
    // Total mensual de gastos del M1
    const m1GastoMensual = Object.values(state.gastos||{}).reduce((a,b)=>a+(b||0),0);
    // Cuotas mensuales de deudas (también afectan flujo)
    const m1DeudaMensual = (state.deudas||[]).reduce((s,d)=>s+(d.cuota_mensual||0),0);
    // Ahorro mensual
    const m1AhorroMensual = (state.ahorro||[]).reduce((s,a)=>s+(a.monto_mensual||0),0);
  
    // Anuales
    const ingresosAnualM1 = m1IngresoMensual * 12;
    const gastosAnualM1Mensuales = m1GastoMensual * 12;
  
    // Para gastos anuales del M5: solo cuentan los que el cliente NO marcó como "ya está en M1"
    // (el flag yaEnM1 lo agrego en p5Cells y collectP5Rows)
    let gastosAnualM5Real = 0;
    p5Cats().forEach(cat=>{
      document.querySelectorAll('#p5-gas-'+cat.id+'-body .multi-row').forEach(r=>{
        const frec  = r.querySelector('select[data-f=frec]')?.value;
        const monto = n(r.querySelector('input[data-f=monto]')?.value);
        const formaPago = r.querySelector('select[data-f=formaPago]')?.value || 'contado';
        const yaEnM1Input = r.querySelector('input[data-f=yaEnM1]');
        const yaEnM1 = yaEnM1Input ? yaEnM1Input.checked : false;
        if(frec === 'NO ES TODOS LOS MESES'){
          // Si el cliente dice que ya está sumado en Ingresos y Gastos, NO sumar (evitar doble registro)
          if(yaEnM1) return;
          gastosAnualM5Real += monto;
        }
      });
    });
  
    const totalIngresosAnio = ingresosAnualM1 + iA;  // M1×12 + ingresos no mensuales del M5
    const totalGastosAnio   = gastosAnualM1Mensuales + gastosAnualM5Real;
    const totalDeudasAnio   = m1DeudaMensual * 12 + dA;
    const totalAhorroAnio   = m1AhorroMensual * 12 + aA;
    const saldo = totalIngresosAnio - totalGastosAnio - totalDeudasAnio - totalAhorroAnio;
  
    const kpi = document.getElementById('m5-saldo-kpi');
    // Construir el desglose visible
    const breakdownHtml = ''
      + '<div class="m5-breakdown">'
      + '<div class="m5-breakdown-title">Cómo se calcula tu año</div>'
      + '<div class="m5-breakdown-grid">'
      + '<div class="m5-bk-item m5-bk-pos"><span class="m5-bk-label">Ingresos mensuales × 12</span><span class="m5-bk-value">+' + fmt(ingresosAnualM1) + '</span><span class="m5-bk-sub">' + fmt(m1IngresoMensual) + ' mensuales</span></div>'
      + '<div class="m5-bk-item m5-bk-pos"><span class="m5-bk-label">Ingresos no mensuales</span><span class="m5-bk-value">+' + fmt(iA) + '</span><span class="m5-bk-sub">Primas, dividendos, devoluciones</span></div>'
      + '<div class="m5-bk-item m5-bk-neg"><span class="m5-bk-label">Gastos mensuales × 12</span><span class="m5-bk-value">−' + fmt(gastosAnualM1Mensuales) + '</span><span class="m5-bk-sub">' + fmt(m1GastoMensual) + ' mensuales</span></div>'
      + '<div class="m5-bk-item m5-bk-neg"><span class="m5-bk-label">Gastos anuales</span><span class="m5-bk-value">−' + fmt(gastosAnualM5Real) + '</span><span class="m5-bk-sub">No incluye los marcados como "ya en Ingresos y Gastos"</span></div>'
      + '<div class="m5-bk-item m5-bk-neg"><span class="m5-bk-label">Cuotas de deudas × 12</span><span class="m5-bk-value">−' + fmt(m1DeudaMensual*12) + '</span><span class="m5-bk-sub">Compromisos de Endeudamiento</span></div>'
      + '<div class="m5-bk-item m5-bk-neg"><span class="m5-bk-label">Ahorro mensual × 12</span><span class="m5-bk-value">−' + fmt(m1AhorroMensual*12) + '</span><span class="m5-bk-sub">Tus objetivos de Ahorro y Solvencia</span></div>'
      + '</div>'
      + '<div class="m5-bk-totals">'
      + '<div class="m5-bk-total"><span>Total ingresos del año</span><strong style="color:var(--pos)">' + fmt(totalIngresosAnio) + '</strong></div>'
      + '<div class="m5-bk-total"><span>Total gastos del año</span><strong style="color:var(--neg)">' + fmt(totalGastosAnio + totalDeudasAnio + totalAhorroAnio) + '</strong></div>'
      + '</div>'
      + '</div>';
  
    kpi.innerHTML = (saldo>=0
      ? '<div class="kpi is-pos"><div class="kpi-label">Saldo proyectado del año</div><div class="kpi-value">+' + fmt(saldo) + '</div><div class="kpi-tag pos">' + SVG_CHECK + 'Año cuadra positivo</div></div>'
      : '<div class="kpi is-neg"><div class="kpi-label">Saldo proyectado del año</div><div class="kpi-value">' + fmt(saldo) + '</div><div class="kpi-tag neg">' + SVG_WARN + 'Faltan ' + fmt(Math.abs(saldo)) + ' para cuadrar</div></div>'
    ) + breakdownHtml;
    Object.assign(state.p5,{ingMensual:iM,ingAnual:iA,deuMensual:dM,deuAnual:dA,ahoMensual:aM,ahoAnual:aA,gastosMensual:gM,gastosAnual:gastosAnualM5Real,saldo});
    // Recalcular provisiones y propagar a M3/M4
    calcProvisiones();
    if(_autosaveReady){ collectP5State(); scheduleSave('presupuesto_anual'); }
  }
  
  /* ═══════════════════════════════════════════════════════════
     FONDO DE PROVISIONES — cálculos y sincronización
     ═══════════════════════════════════════════════════════════ */
  
  /* Suma de TODOS los gastos anuales del M5 (frec NO ES TODOS LOS MESES) */
  function getTotalGastosAnualesP5(){
    let total = 0;
    p5Cats().forEach(cat=>{
      document.querySelectorAll('#p5-gas-'+cat.id+'-body .multi-row').forEach(r=>{
        const frec = r.querySelector('select[data-f=frec]')?.value;
        const monto = n(r.querySelector('input[data-f=monto]')?.value);
        if(frec === 'NO ES TODOS LOS MESES') total += monto;
      });
    });
    return total;
  }
  
  /* Suma SOLO de los gastos anuales que el usuario marcó como "provisionar mensualmente" */
  function getTotalGastosProvisionablesP5(){
    let total = 0;
    p5Cats().forEach(cat=>{
      document.querySelectorAll('#p5-gas-'+cat.id+'-body .multi-row').forEach(r=>{
        const frec = r.querySelector('select[data-f=frec]')?.value;
        const monto = n(r.querySelector('input[data-f=monto]')?.value);
        const provInput = r.querySelector('input[data-f=provisionar]');
        const provisionar = provInput ? provInput.checked : true;
        if(frec === 'NO ES TODOS LOS MESES' && provisionar) total += monto;
      });
    });
    return total;
  }
  
  /* Suma de gastos anuales que vencen en los próximos 90 días */
  function getGastosProximos90Dias(opts){
    opts = opts || {};
    const soloProvisionables = !!opts.soloProvisionables;
    const hoy = new Date();
    const mesActual = hoy.getMonth() + 1;
    const mesesProximos = [];
    for(let i=0;i<3;i++){
      const m = ((mesActual - 1 + i) % 12) + 1;
      mesesProximos.push(String(m).padStart(2,'0'));
    }
    let total = 0;
    p5Cats().forEach(cat=>{
      document.querySelectorAll('#p5-gas-'+cat.id+'-body .multi-row').forEach(r=>{
        const frec = r.querySelector('select[data-f=frec]')?.value;
        const mes  = r.querySelector('select[data-f=mes]')?.value;
        const monto = n(r.querySelector('input[data-f=monto]')?.value);
        const provInput = r.querySelector('input[data-f=provisionar]');
        const provisionar = provInput ? provInput.checked : true;
        if(frec === 'NO ES TODOS LOS MESES' && mesesProximos.includes(mes)){
          if(soloProvisionables && !provisionar) return;
          total += monto;
        }
      });
    });
    return total;
  }
  
  /* Aporte mensual sugerido al fondo de provisiones (solo gastos provisionables) */
  function calcAporteProvisionesSugerido(){
    const totalAnual = getTotalGastosProvisionablesP5();
    return Math.ceil(totalAnual / 12 / 10000) * 10000; // redondeo a 10.000
  }
  
  /* Recalcula todo lo de provisiones, actualiza UI y propaga a M3/M4 */
  function calcProvisiones(){
    const totalAnual = getTotalGastosAnualesP5();
    const totalProvisionable = getTotalGastosProvisionablesP5();
    const aporteMensual = calcAporteProvisionesSugerido();
    // Para el índice de previsión, solo cuentan los gastos que el cliente sí va a provisionar
    const proximos90 = getGastosProximos90Dias({soloProvisionables:true});
    const proximos90Total = getGastosProximos90Dias({soloProvisionables:false});
    const saldoActual = state.p5.fondoProvisiones || 0;
    const indicePrev = proximos90 > 0 ? Math.min(saldoActual / proximos90, 1) : 1;
  
    // Actualizar UI del panel
    const aporteEl = document.getElementById('prov-aporte-sugerido');
    const aporteSubEl = document.getElementById('prov-aporte-sub');
    const indiceEl = document.getElementById('prov-indice-prevision');
    const alertEl = document.getElementById('prov-alert');
  
    if(aporteEl){
      if(totalProvisionable > 0){
        aporteEl.textContent = fmt(aporteMensual);
        const noProvisionable = totalAnual - totalProvisionable;
        const sufijo = noProvisionable > 0
          ? ' anuales ÷ 12 · <span style="color:var(--warn)">' + fmt(noProvisionable) + ' sin provisionar</span>'
          : ' anuales ÷ 12 meses';
        aporteSubEl.innerHTML = fmt(totalProvisionable) + sufijo;
      } else if(totalAnual > 0){
        aporteEl.textContent = fmt(0);
        aporteSubEl.innerHTML = '<span style="color:var(--warn)">Marcaste todos los gastos como "no provisionar". Asumes el riesgo de financiarlos.</span>';
      } else {
        aporteEl.textContent = '—';
        aporteSubEl.textContent = 'Registra gastos anuales para calcular';
      }
    }
  
    if(indiceEl){
      if(proximos90Total > 0){
        indiceEl.textContent = pct(indicePrev);
        indiceEl.style.color = indicePrev >= 1 ? 'var(--pos)' : indicePrev >= 0.6 ? 'var(--warn)' : 'var(--neg)';
      } else {
        indiceEl.textContent = '—';
        indiceEl.style.color = '';
      }
    }
  
    if(alertEl){
      if(totalAnual === 0){
        alertEl.style.display = 'none';
      } else if(proximos90 > saldoActual){
        const faltante = proximos90 - saldoActual;
        const costoFin = faltante * 0.28;
        alertEl.className = 'alert warn';alertEl.style.display = 'flex';
        alertEl.innerHTML = SVG_WARN + '<div><strong>En los próximos 90 días vencen ' + fmt(proximos90) + ' en gastos anuales y solo tienes ' + fmt(saldoActual) + ' provisionado.</strong> Si te toca financiar el faltante de ' + fmt(faltante) + ' con tarjeta a 28% anual, el costo extra sería de hasta <strong>' + fmt(costoFin) + '</strong>. Empezar a apartar el aporte mensual sugerido evita ese sobrecosto.</div>';
      } else if(saldoActual >= totalAnual){
        alertEl.className = 'alert pos';alertEl.style.display = 'flex';
        alertEl.innerHTML = SVG_CHECK + '<div><strong>Fondo de provisiones completo.</strong> Tienes provisionado todo lo del año. Lo que aportes ahora puede destinarse al fondo de emergencias o a inversión.</div>';
      } else {
        alertEl.className = 'alert pos';alertEl.style.display = 'flex';
        alertEl.innerHTML = SVG_CHECK + '<div><strong>Cobertura suficiente para el corto plazo.</strong> Tienes ' + fmt(saldoActual) + ' provisionados y los próximos 90 días requieren ' + fmt(proximos90) + '. Sigue aportando ' + fmt(aporteMensual) + ' mensuales para llegar al fondo anual completo.</div>';
      }
    }
  
    // Propagar a M3 (activo líquido sincronizado) y M4 (objetivo de ahorro sugerido)
    if(typeof renderActivosTable === 'function'){renderActivosTable();calcM3();}
    if(typeof renderAhorroTable === 'function'){renderAhorroTable();calcM4();}
  
    // Renderear calendario anual
    renderCalendarioAnual();
  }
  
  /* ═══════════════════════════════════════════════════════════
     CALENDARIO ANUAL — Renderiza próximos 12 meses con eventos
     ═══════════════════════════════════════════════════════════ */
  function recolectarEventosAnuales(){
    const eventos = [];
  
    p5Cats().forEach(cat=>{
      document.querySelectorAll('#p5-gas-'+cat.id+'-body .multi-row').forEach(r=>{
        const frec  = r.querySelector('select[data-f=frec]')?.value;
        const mes   = r.querySelector('select[data-f=mes]')?.value;
        const monto = n(r.querySelector('input[data-f=monto]')?.value);
        const nombre = r.querySelector('input[data-f=nombre]')?.value || 'Sin nombre';
        const provInput = r.querySelector('input[data-f=provisionar]');
        const provisionar = provInput ? provInput.checked : true;
        if(frec === 'NO ES TODOS LOS MESES' && mes && mes !== 'varia' && monto > 0){
          eventos.push({tipo:'gasto', nombre:nombre, monto:monto, mes:parseInt(mes), provisionar:provisionar});
        }
      });
    });
  
    document.querySelectorAll('#p5-ingresos-body .multi-row').forEach(r=>{
      const frec  = r.querySelector('select[data-f=frec]')?.value;
      const mes   = r.querySelector('select[data-f=mes]')?.value;
      const monto = n(r.querySelector('input[data-f=monto]')?.value);
      const nombre = r.querySelector('input[data-f=nombre]')?.value || 'Sin nombre';
      if(frec === 'NO ES TODOS LOS MESES' && mes && mes !== 'varia' && monto > 0){
        eventos.push({tipo:'ingreso', nombre:nombre, monto:monto, mes:parseInt(mes)});
      }
    });
  
    return eventos;
  }
  
  function renderCalendarioAnual(){
    const grid = document.getElementById('m5-calendar');
    if(!grid) return;
    grid.innerHTML = '';
  
    const eventos = recolectarEventosAnuales();
    const hoy = new Date();
    const mesActual = hoy.getMonth(); // 0-11
    const yearActual = hoy.getFullYear();
  
    // Saldo del fondo de provisiones disponible (consumo simulado por orden cronológico)
    let saldoDisponible = state.p5.fondoProvisiones || 0;
    const aporteMensual = calcAporteProvisionesSugerido();
  
    let totalGastosAnio = 0, totalIngresosAnio = 0;
    let mesesConWarn = 0;
  
    for(let i=0;i<12;i++){
      const dMes = (mesActual + i) % 12;       // 0-11
      const dYear = mesActual + i >= 12 ? yearActual+1 : yearActual;
      const mesNum = dMes + 1;                  // 1-12
  
      // Eventos de este mes
      const eventosDelMes = eventos.filter(e => e.mes === mesNum);
      const ingresosMes = eventosDelMes.filter(e => e.tipo === 'ingreso');
      const gastosMes = eventosDelMes.filter(e => e.tipo === 'gasto');
  
      // Sumar aporte mensual al saldo (simulación de provisión continua)
      if(i > 0) saldoDisponible += aporteMensual;
  
      // Determinar para cada gasto si está provisionado
      let gastoTotalMes = 0;
      let ingresoTotalMes = 0;
      let mesTieneWarn = false;
      const eventosRender = [];
  
      ingresosMes.forEach(e => {
        ingresoTotalMes += e.monto;
        totalIngresosAnio += e.monto;
        eventosRender.push({...e, claseDot:'ingreso'});
      });
  
      gastosMes.forEach(e => {
        gastoTotalMes += e.monto;
        totalGastosAnio += e.monto;
        if(e.provisionar === false){
          // Cliente decidió no provisionar este gasto: siempre aparece como riesgo
          eventosRender.push({...e, claseDot:'gasto-warn', sinProv:true, sinProvisionar:true});
          mesTieneWarn = true;
        } else {
          const provisionado = saldoDisponible >= e.monto;
          if(provisionado){
            saldoDisponible -= e.monto;
            eventosRender.push({...e, claseDot:'gasto-ok', sinProv:false});
          } else {
            eventosRender.push({...e, claseDot:'gasto-warn', sinProv:true});
            mesTieneWarn = true;
          }
        }
      });
  
      if(mesTieneWarn) mesesConWarn++;
  
      // HTML del mes
      const mesEl = document.createElement('div');
      mesEl.className = 'cal-mes';
      if(eventosDelMes.length > 0) mesEl.classList.add('tiene-eventos');
      if(mesTieneWarn) mesEl.classList.add('tiene-warn');
      if(i === 0) mesEl.classList.add('is-current');
  
      const eventosHtml = eventosRender.length > 0
        ? eventosRender.map(e => {
            const tag = e.sinProvisionar ? ' <span class="cal-event-tag">no provisionar</span>' : '';
            return '<div class="cal-event">'
              + '<span class="cal-event-dot ' + e.claseDot + '"></span>'
              + '<span class="cal-event-name" title="' + e.nombre + '">' + e.nombre + tag + '</span>'
              + '<span class="cal-event-monto">' + fmtNum(e.monto) + '</span>'
              + '</div>';
          }).join('')
        : '<div class="cal-empty">Sin eventos</div>';
  
      let totalHtml = '';
      if(gastoTotalMes > 0 || ingresoTotalMes > 0){
        const neto = ingresoTotalMes - gastoTotalMes;
        totalHtml = '<div class="cal-mes-total"><span>Neto</span><span style="color:'
          + (neto >= 0 ? 'var(--pos)' : 'var(--neg)') + '">'
          + (neto >= 0 ? '+' : '') + fmtNum(neto) + '</span></div>';
      }
  
      mesEl.innerHTML = '<div class="cal-mes-head">'
        + '<span class="cal-mes-name">' + MES_NAMES_FULL[dMes] + '</span>'
        + '<span class="cal-mes-year">' + dYear + '</span>'
        + '</div>'
        + '<div class="cal-mes-events">' + eventosHtml + '</div>'
        + totalHtml;
      grid.appendChild(mesEl);
    }
  
    // Resumen al final, fuera del grid de meses
    let summaryWrap = document.getElementById('m5-calendar-summary');
    if(!summaryWrap){
      summaryWrap = document.createElement('div');
      summaryWrap.id = 'm5-calendar-summary';
      summaryWrap.className = 'cal-summary';
      grid.parentNode.insertBefore(summaryWrap, grid.nextSibling);
    }
    const costoFinanciamiento = mesesConWarn > 0
      ? eventos.filter(e => e.tipo === 'gasto').reduce((a,e)=>a+e.monto,0) * 0.28 * (mesesConWarn/12)
      : 0;
    summaryWrap.innerHTML = ''
      + '<div class="cal-summary-item"><span class="cal-summary-label">Ingresos anuales</span><span class="cal-summary-value" style="color:var(--pos)">' + fmt(totalIngresosAnio) + '</span></div>'
      + '<div class="cal-summary-item"><span class="cal-summary-label">Gastos anuales</span><span class="cal-summary-value" style="color:var(--neg)">' + fmt(totalGastosAnio) + '</span></div>'
      + '<div class="cal-summary-item"><span class="cal-summary-label">Meses con riesgo</span><span class="cal-summary-value" style="color:'+(mesesConWarn>0?'var(--warn)':'var(--pos)')+'">' + mesesConWarn + ' de 12</span></div>'
      + '<div class="cal-summary-item"><span class="cal-summary-label">Costo financiación estimado</span><span class="cal-summary-value" style="color:'+(costoFinanciamiento>0?'var(--neg)':'var(--ink-3)')+'">' + (costoFinanciamiento>0?fmt(costoFinanciamiento):'—') + '</span></div>';
  }
  
  /* ═══════════════════════════════════════════════════════════
     RENDER — listas y filas
     ═══════════════════════════════════════════════════════════ */
  const GASTO_LABELS = {alimentacion:'Alimentación',vivienda:'Vivienda',transporte:'Transporte',salud:'Salud',entretenimiento:'Entretenimiento',comunicaciones:'Comunicaciones',otros:'Otros'};
  
  function makeMoneyInput(value, dataField, placeholder='0'){
    const inp = document.createElement('input');
    inp.className='money-input';
    inp.type='text';
    inp.inputMode='numeric';
    inp.placeholder=placeholder;
    inp.dataset.f=dataField;
    inp.value = value && value>0 ? fmtInput(value) : '';
    attachMoneyInput(inp);
    return inp;
  }
  
  function renderIngresosTable(){
    const body=document.getElementById('ingresos-body');
    body.innerHTML='';
  
    const mvarActive = state.varIncome && state.varIncome.active;
    const salarioPersonal = mvarActive ? getSalarioPersonalActual() : 0;
  
    // La fila de ingreso variable es DEDICADA (linkedToMVar), no roba una fila fija del usuario.
    state.ingresos.forEach(x=>{ if(x.esVariable) delete x.esVariable; });   // limpiar marca antigua
    state.ingresos = state.ingresos.filter(x=>!x.linkedToMVar);              // quitar la sincronizada previa
    if(mvarActive){
      state.ingresos.push({nombre:'Ingreso variable (salario personal)', monto:salarioPersonal, linkedToMVar:true});
    }
  
    state.ingresos.forEach((ing,i)=>{
      const row=document.createElement('div');
      row.className='item-row';
      const isVariable = !!ing.linkedToMVar;
  
      if(isVariable){
        row.classList.add('item-row-locked');
        row.innerHTML = '<div class="it-locked-wrap">'
          + '<div class="it-locked-name">' + (ing.nombre||'Ingreso variable') + ' <span class="it-locked-badge">sincronizado</span></div>'
          + '<div class="it-locked-sub">Salario personal del módulo de ingresos variables · <a href="#" class="it-locked-link" data-go-mvar>Ajustar allá</a></div>'
          + '</div>'
          + '<span class="it-prefix">' + currency + '</span>'
          + '<span class="it-locked-amount num">' + (fmtInput(ing.monto||0) || '0') + '</span>'
          + '<span class="it-empty"></span>';
        body.appendChild(row);
        const link = row.querySelector('[data-go-mvar]');
        if(link) link.addEventListener('click',function(e){e.preventDefault();navigateTo('var');});
      } else {
        row.innerHTML = '<input type="text" class="it-name" data-f="nombre" value="' + (ing.nombre||'') + '" placeholder="Fuente de ingreso (salario, etc.)">'
          + '<span class="it-prefix">' + currency + '</span>'
          + '<input class="money-input" data-f="monto">'
          + '<button class="it-del" title="Eliminar">' + SVG_X + '</button>';
        body.appendChild(row);
        const moneyInp = row.querySelector('.money-input');
        moneyInp.value = ing.monto && ing.monto>0 ? fmtInput(ing.monto) : '';
        moneyInp.placeholder='0';
        attachMoneyInput(moneyInp);
        row.querySelectorAll('input').forEach(inp=>inp.addEventListener('input',calcM1));
        row.querySelector('.it-del').addEventListener('click',()=>{
          const editables = state.ingresos.filter(x=>!x.linkedToMVar).length;
          if(editables<=1 && !mvarActive) return;        // siempre dejar al menos una fila utilizable
          state.ingresos.splice(i,1);
          renderIngresosTable();calcM1();
        });
      }
    });
  
    // Grid uniforme (4 columnas): ya no hay toggle de "marcar como variable"
    body.querySelectorAll('.item-row').forEach(r=>{
      r.style.gridTemplateColumns='1fr auto auto auto';
    });
  
    // Mostrar nota informativa si MVar activo
    const noteEl = document.getElementById('m1-mvar-note');
    if(noteEl) noteEl.style.display = mvarActive ? 'flex' : 'none';
  }
  
  function gastoLabel(k){
    return (state.gastosLabels && state.gastosLabels[k]) || GASTO_LABELS[k] || 'Categoría';
  }
  function isGastoCustom(k){ return !(k in GASTO_LABELS); }

  /* Clave de la categoría sincronizada de cargos de tarjeta */
  const CARGOS_CAT_KEY = 'cargos_comisiones';

  /* Orden persistente de las categorías de gasto. Los objetos no conservan el orden
     de claves al releer desde Firestore, por eso el orden vive en este arreglo. */
  function gastoCatOrder(){
    if(!Array.isArray(state.gastosOrder)) state.gastosOrder = [];
    Object.keys(state.gastos).forEach(k=>{ if(!state.gastosOrder.includes(k)) state.gastosOrder.push(k); });
    state.gastosOrder = state.gastosOrder.filter(k => k in state.gastos);
    return state.gastosOrder;
  }

  /* Snapshot persistible de gastos: excluye ítems sincronizados (linkedToDeuda) y omite la
     categoría de cargos si solo tenía ítems sincronizados. Lo sincronizado se regenera desde M2. */
  function gastosForSave(){
    const gastos={}, gastosItems={}, gastosOrder=[];
    gastoCatOrder().forEach(k=>{
      const its=(state.gastosItems[k]||[]).filter(it=>!it.linkedToDeuda);
      if(k===CARGOS_CAT_KEY && its.length===0) return; // categoría auto-generada y vacía: no persistir
      gastosItems[k]=its;
      gastos[k]=its.reduce((s,it)=>s+(it.monto||0),0);
      gastosOrder.push(k);
    });
    return {gastos, gastosItems, gastosLabels:state.gastosLabels||{}, gastosOrder};
  }

  /* Asegura la estructura de items por categoría y migra montos antiguos a un item. */
  function ensureGastosItems(){
    if(!state.gastosItems || typeof state.gastosItems!=='object') state.gastosItems={};
    Object.keys(state.gastos).forEach(k=>{
      if(!Array.isArray(state.gastosItems[k])){
        const total = state.gastos[k]||0;
        state.gastosItems[k] = total>0 ? [{nombre:'', monto:total}] : [];
      }
    });
    // categorías que existan solo en items
    Object.keys(state.gastosItems).forEach(k=>{ if(!(k in state.gastos)) state.gastos[k]=0; });
  }
  function recomputeGastoTotal(k){
    const items = state.gastosItems[k]||[];
    state.gastos[k] = items.reduce((s,it)=>s+(it.monto||0),0);
    return state.gastos[k];
  }
  function recomputeGastosTotales(){ Object.keys(state.gastos).forEach(recomputeGastoTotal); }

  let _gastosTarget='gastos-body';
  function renderGastosTable(targetId){
    if(targetId) _gastosTarget=targetId;
    ensureGastosItems();
    const body=document.getElementById(_gastosTarget);
    if(!body) return;
    body.innerHTML='';
    gastoCatOrder().forEach(k=>{
      const custom = isGastoCustom(k);
      const items = state.gastosItems[k] || (state.gastosItems[k]=[]);
      recomputeGastoTotal(k);

      const cat=document.createElement('div');
      cat.className='gasto-cat';
      cat.dataset.catkey=k;

      // Encabezado: handle de arrastre + nombre editable + total automático + acciones
      const head=document.createElement('div');
      head.className='gasto-cat-head';
      head.innerHTML =
        `<button class="gasto-cat-drag" title="Arrastra para reordenar la categoría">${SVG_DRAG_HANDLE}</button>`
        + `<input class="it-cat-name gasto-cat-name" data-labelkey="${k}" value="${String(gastoLabel(k)).replace(/"/g,'&quot;')}" placeholder="${custom?'Nombre de la categoría':GASTO_LABELS[k]}">`
        + `<div class="gasto-cat-total"><span class="gasto-cat-total-label">Total</span><span class="gasto-cat-total-val" data-cat-total="${k}">${fmt(state.gastos[k])}</span></div>`
        + `<button class="gasto-add-btn" title="Agregar gasto a esta categoría" data-add-item="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Gasto</span></button>`
        + `<button class="it-del gasto-cat-del" title="Eliminar categoría">${SVG_X}</button>`;
      cat.appendChild(head);

      // Items
      const itemsWrap=document.createElement('div');
      itemsWrap.className='gasto-cat-items';
      cat.appendChild(itemsWrap);
      body.appendChild(cat);

      const renderItems=()=>{
        itemsWrap.innerHTML='';
        if(!items.length){
          itemsWrap.innerHTML=`<div class="gasto-cat-empty">Sin gastos registrados. Usa “+ Gasto”.</div>`;
        }
        items.forEach((it,idx)=>{
          if(it.linkedToDeuda){
            const lrow=document.createElement('div');
            lrow.className='item-row gasto-item-row item-row-locked';
            lrow.style.gridTemplateColumns='1fr auto auto';
            lrow.dataset.itemIdx=idx;
            lrow.innerHTML =
              `<div class="it-locked-wrap"><div class="it-locked-name">${String(it.nombre||'').replace(/</g,'&lt;')} <span class="it-locked-badge">sincronizado</span></div>`
              + `<div class="it-locked-sub">Cargo de una tarjeta · <a href="#" class="it-locked-link" data-go-m2>Ajustar en Endeudamiento</a></div></div>`
              + `<span class="it-prefix">${currency}</span>`
              + `<span class="it-locked-amount num">${fmtInput(it.monto||0) || '0'}</span>`;
            itemsWrap.appendChild(lrow);
            const lnk=lrow.querySelector('[data-go-m2]');
            if(lnk) lnk.addEventListener('click',function(e){e.preventDefault();navigateTo(2);});
            return;
          }
          const row=document.createElement('div');
          row.className='item-row gasto-item-row';
          row.style.gridTemplateColumns='auto 1fr auto auto auto';
          row.dataset.itemIdx=idx;
          row.innerHTML =
            `<button class="gasto-item-drag" title="Arrastra para reordenar el gasto">${SVG_DRAG_HANDLE}</button>`
            + `<input type="text" class="it-name" data-f="nombre" value="${String(it.nombre||'').replace(/"/g,'&quot;')}" placeholder="¿En qué? (ej: arriendo, mercado)">`
            + `<span class="it-prefix">${currency}</span>`
            + `<input class="money-input" data-f="monto">`
            + `<button class="it-del" title="Eliminar gasto">${SVG_X}</button>`;
          itemsWrap.appendChild(row);
          const montoInp=row.querySelector('.money-input');
          montoInp.value = it.monto>0 ? fmtInput(it.monto) : '';
          montoInp.placeholder='0';
          attachMoneyInput(montoInp);
          montoInp.addEventListener('input',function(){
            it.monto=n(this.value);
            const tot=recomputeGastoTotal(k);
            head.querySelector(`[data-cat-total="${k}"]`).textContent=fmt(tot);
            calcM1();
            if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
          });
          row.querySelector('.it-name').addEventListener('input',function(){
            it.nombre=this.value;
            if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
          });
          row.querySelector('.it-del').addEventListener('click',function(){
            const doDelete=function(){
              items.splice(idx,1);
              const tot=recomputeGastoTotal(k);
              head.querySelector(`[data-cat-total="${k}"]`).textContent=fmt(tot);
              renderItems();calcM1();
              if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
            };
            const tieneContenido=(it.nombre||'').trim() || (it.monto||0)>0;
            if(tieneContenido){
              showConfirm({
                title:'Eliminar gasto',
                msg: it.nombre ? ('¿Eliminar "'+it.nombre+'"?') : '¿Eliminar este gasto?',
                confirmText:'Eliminar', danger:true, onConfirm:doDelete
              });
            } else doDelete();
          });
          // Arrastre del gasto dentro de la categoría
          wireGastoItemDrag(row.querySelector('.gasto-item-drag'), row, itemsWrap, function(){
            const order=Array.from(itemsWrap.querySelectorAll('.gasto-item-row')).map(r=>parseInt(r.dataset.itemIdx,10));
            const reordered=order.map(i=>items[i]).filter(v=>v!==undefined);
            items.length=0; reordered.forEach(it=>items.push(it));
            const tot=recomputeGastoTotal(k);
            head.querySelector(`[data-cat-total="${k}"]`).textContent=fmt(tot);
            renderItems();calcM1();
            if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
          });
        });
      };
      renderItems();

      // Nombre de categoría editable
      head.querySelector('.it-cat-name').addEventListener('input',function(){
        if(!state.gastosLabels) state.gastosLabels={};
        state.gastosLabels[k]=this.value;
        if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
      });
      // Agregar gasto
      head.querySelector(`[data-add-item="${k}"]`).addEventListener('click',function(){
        items.push({nombre:'',monto:0});
        renderItems();
        const last=itemsWrap.querySelector('.gasto-item-row:last-child .it-name');
        if(last) last.focus();
      });
      // Eliminar categoría (cualquiera, incluidas las predeterminadas)
      head.querySelector('.gasto-cat-del').addEventListener('click',function(){
        showConfirm({
          title:'Eliminar categoría',
          msg:'¿Eliminar la categoría "'+(gastoLabel(k)||'')+'" y todos sus gastos?',
          confirmText:'Eliminar', danger:true,
          onConfirm:function(){
            delete state.gastos[k];
            delete state.gastosItems[k];
            if(state.gastosLabels) delete state.gastosLabels[k];
            if(Array.isArray(state.gastosOrder)) state.gastosOrder = state.gastosOrder.filter(x=>x!==k);
            renderGastosTable();calcM1();
            if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
          }
        });
      });
      // Arrastre para reordenar la categoría
      wireGastoCatDrag(head.querySelector('.gasto-cat-drag'), cat, body);
    });
  }

  /* Arrastre de CATEGORÍAS de gasto (M1) */
  function wireGastoCatDrag(handle, catDiv, body){
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      e.preventDefault();
      catDiv.classList.add('p5-cat-dragging');
      document.body.style.userSelect='none'; document.body.style.cursor='grabbing';
      function move(ev){
        const sibs=Array.from(body.querySelectorAll('.gasto-cat:not(.p5-cat-dragging)'));
        let placed=false;
        for(const sib of sibs){ const r=sib.getBoundingClientRect(); if(ev.clientY < r.top+r.height/2){ body.insertBefore(catDiv, sib); placed=true; break; } }
        if(!placed) body.appendChild(catDiv);
      }
      function end(){
        document.removeEventListener('pointermove',move);
        document.removeEventListener('pointerup',end);
        document.removeEventListener('pointercancel',end);
        document.body.style.userSelect=''; document.body.style.cursor='';
        catDiv.classList.remove('p5-cat-dragging');
        // Guardar el nuevo orden en el arreglo persistente (Firestore no conserva orden de claves)
        state.gastosOrder = Array.from(body.querySelectorAll('.gasto-cat')).map(c=>c.dataset.catkey);
        calcM1();
        if(typeof scheduleSave==='function') scheduleSave('ingresos_gastos');
      }
      document.addEventListener('pointermove',move);
      document.addEventListener('pointerup',end);
      document.addEventListener('pointercancel',end);
    });
  }

  /* Arrastre de un GASTO dentro de su categoría (M1) */
  function wireGastoItemDrag(handle, rowDiv, itemsWrap, onDrop){
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      e.preventDefault();
      rowDiv.classList.add('p5-row-dragging');
      document.body.style.userSelect='none'; document.body.style.cursor='grabbing';
      function move(ev){
        const sibs=Array.from(itemsWrap.querySelectorAll('.gasto-item-row:not(.p5-row-dragging)'));
        let placed=false;
        for(const sib of sibs){ const r=sib.getBoundingClientRect(); if(ev.clientY < r.top+r.height/2){ itemsWrap.insertBefore(rowDiv, sib); placed=true; break; } }
        if(!placed) itemsWrap.appendChild(rowDiv);
      }
      function end(){
        document.removeEventListener('pointermove',move);
        document.removeEventListener('pointerup',end);
        document.removeEventListener('pointercancel',end);
        document.body.style.userSelect=''; document.body.style.cursor='';
        rowDiv.classList.remove('p5-row-dragging');
        if(typeof onDrop==='function') onDrop();
      }
      document.addEventListener('pointermove',move);
      document.addEventListener('pointerup',end);
      document.addEventListener('pointercancel',end);
    });
  }

  function addGastoCategoria(){
    const key='cat_'+Date.now().toString(36)+Math.floor(Math.random()*1000).toString(36);
    state.gastos[key]=0;
    if(!state.gastosItems) state.gastosItems={};
    state.gastosItems[key]=[{nombre:'',monto:0}];
    if(!state.gastosLabels) state.gastosLabels={};
    state.gastosLabels[key]='';
    if(!Array.isArray(state.gastosOrder)) state.gastosOrder=[];
    state.gastosOrder.push(key);
    renderGastosTable();calcM1();
    const nuevo=document.querySelector(`#${_gastosTarget} input[data-labelkey="${key}"]`);
    if(nuevo) nuevo.focus();
  }
  
  function makeMultiRow(fields, opts={}){
    const row=document.createElement('div');
    row.className='multi-row';
    if(opts.rowId) row.dataset.id=opts.rowId;
    let html=`<div class="mr-head"><input type="text" class="it-name" data-f="nombre" value="${fields.nombre||''}" placeholder="${opts.namePlaceholder||'Descripción'}">
      <button class="it-del" title="Eliminar">${SVG_X}</button></div>
      <div class="mr-grid">`;
    opts.cells.forEach(c=>html+=c);
    html+=`</div>`;
    row.innerHTML=html;
    return row;
  }
  
  function renderDeudasTable(){
    const body=document.getElementById('deudas-body');
    body.innerHTML='';
    if(state.deudas.length===0) addDeudaRow();
    else state.deudas.forEach((_,i)=>addDeudaRowFromState(i));
  }
  function deudaCells(d){
    return [
      `<div class="mr-field"><label>Saldo total</label><input class="money-input" data-f="saldo" placeholder="0"></div>`,
      `<div class="mr-field"><label>Cuota mensual</label><input class="money-input" data-f="cuota" placeholder="0"></div>`,
      `<div class="mr-field"><label>Tasa anual %</label><input type="number" data-f="tasa" value="${((d.tasa_anual||0)*100).toFixed(1)}" min="0" max="200" step="0.1"></div>`,
      `<div class="mr-field full"><label>Tipo de deuda</label><select data-f="tipo">${debtTypeOptions(d.tipo||'CONSUMO_TARJETA')}</select></div>`
    ].join('');
  }
  function addDeudaRowFromState(i){
    const d=state.deudas[i]||{nombre:'',saldo:0,cuota_mensual:0,tasa_anual:0,tipo:'CONSUMO_TARJETA'};
    if(!d.id){ d.id=genDebtId(); }
    const body=document.getElementById('deudas-body');
    const row=makeMultiRow(d,{cells:[deudaCells(d)],namePlaceholder:'Nombre de la deuda (ej: Tarjeta Visa, Préstamo mamá)',rowId:d.id});
    body.appendChild(row);
    const sIn=row.querySelector('input[data-f=saldo]');  sIn.value=d.saldo>0?fmtInput(d.saldo):'';attachMoneyInput(sIn);
    const cIn=row.querySelector('input[data-f=cuota]'); cIn.value=d.cuota_mensual>0?fmtInput(d.cuota_mensual):'';attachMoneyInput(cIn);
    row.querySelectorAll('input,select').forEach(el=>{el.addEventListener('input',calcM2);if(el.tagName==='SELECT')el.addEventListener('change',calcM2);});
    row.querySelector('.it-del').addEventListener('click',()=>{row.remove();calcM2();});

    // ── Cargos recurrentes (solo tarjetas de crédito) ──
    const grid=row.querySelector('.mr-grid');
    const cargosCell=document.createElement('div');
    cargosCell.className='mr-field full deuda-cargos-cell';
    cargosCell.dataset.cargosCell='';
    cargosCell.innerHTML=
      '<div class="deuda-cargos-head">'
      + '<span class="deuda-cargos-title">Cargos recurrentes</span>'
      + '<span class="deuda-cargos-hint">cuota de manejo, seguro… (aparte de la cuota)</span>'
      + '</div>'
      + '<div class="deuda-cargos-list" data-cargos-list></div>'
      + '<button type="button" class="deuda-cargo-add" data-cargo-add><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Agregar cargo</button>'
      + '<div class="deuda-cargos-sync">' + SVG_INFO + '<span>Aparece como gasto sincronizado en Ingresos y Gastos, categoría “Cargos y comisiones”. No se suma a la cuota.</span></div>';
    grid.appendChild(cargosCell);
    const listEl=cargosCell.querySelector('[data-cargos-list]');
    (d.cargos||[]).forEach(cg=>buildCargoRow(cg, listEl));
    cargosCell.querySelector('[data-cargo-add]').addEventListener('click',function(){
      const r=buildCargoRow({nombre:'',monto:0}, listEl);
      const ni=r.querySelector('[data-cf=nombre]'); if(ni) ni.focus();
      calcM2();
    });
    const tipoSel=row.querySelector('select[data-f=tipo]');
    function toggleCargos(){ cargosCell.style.display = (tipoSel && tipoSel.value==='CONSUMO_TARJETA') ? '' : 'none'; }
    if(tipoSel) tipoSel.addEventListener('change', toggleCargos);
    toggleCargos();
  }

  /* Una fila de cargo recurrente dentro de una deuda */
  function buildCargoRow(cg, listEl){
    const r=document.createElement('div');
    r.className='deuda-cargo-row';
    r.innerHTML=
      '<input type="text" class="it-name" data-cf="nombre" placeholder="Cargo (ej: cuota de manejo)">'
      + '<span class="it-prefix">'+currency+'</span>'
      + '<input class="money-input" data-cf="monto">'
      + '<button type="button" class="it-del" data-cargo-del title="Eliminar cargo">'+SVG_X+'</button>';
    listEl.appendChild(r);
    r.querySelector('[data-cf=nombre]').value = cg.nombre||'';
    const m=r.querySelector('[data-cf=monto]'); m.value = (cg.monto>0)?fmtInput(cg.monto):''; m.placeholder='0'; attachMoneyInput(m);
    r.querySelectorAll('input').forEach(inp=>inp.addEventListener('input',calcM2));
    r.querySelector('[data-cargo-del]').addEventListener('click',function(){ r.remove(); calcM2(); });
    return r;
  }

  /* Sincroniza los cargos de las tarjetas de crédito hacia la categoría "Cargos y comisiones" de M1.
     Se regenera por completo el subconjunto vinculado, así el borrado de una tarjeta arrastra su cargo. */
  let _cargoSig='';
  function syncCargosTarjeta(){
    const cargoItems=[];
    (state.deudas||[]).forEach(d=>{
      if(d.tipo!=='CONSUMO_TARJETA') return;
      (d.cargos||[]).forEach(cg=>{
        const monto=cg.monto||0;
        const cn=(cg.nombre||'').trim();
        if(monto<=0 && !cn) return;
        const dn=(d.nombre||'').trim()||'Tarjeta';
        cargoItems.push({nombre: dn+' · '+(cn||'Cargo'), monto, linkedToDeuda:true});
      });
    });
    if(!state.gastosItems) state.gastosItems={};
    const existing = Array.isArray(state.gastosItems[CARGOS_CAT_KEY]) ? state.gastosItems[CARGOS_CAT_KEY] : [];
    const manual = existing.filter(it=>!it.linkedToDeuda);
    if(cargoItems.length===0 && manual.length===0){
      // nada que mostrar: elimina la categoría auto-generada si existía
      if(CARGOS_CAT_KEY in state.gastos){
        delete state.gastos[CARGOS_CAT_KEY];
        delete state.gastosItems[CARGOS_CAT_KEY];
        if(state.gastosLabels) delete state.gastosLabels[CARGOS_CAT_KEY];
        if(Array.isArray(state.gastosOrder)) state.gastosOrder=state.gastosOrder.filter(k=>k!==CARGOS_CAT_KEY);
      }
    } else {
      if(!(CARGOS_CAT_KEY in state.gastos)) state.gastos[CARGOS_CAT_KEY]=0;
      if(!state.gastosLabels) state.gastosLabels={};
      if(!state.gastosLabels[CARGOS_CAT_KEY]) state.gastosLabels[CARGOS_CAT_KEY]='Cargos y comisiones';
      state.gastosItems[CARGOS_CAT_KEY]=manual.concat(cargoItems);
      if(!Array.isArray(state.gastosOrder)) state.gastosOrder=[];
      if(!state.gastosOrder.includes(CARGOS_CAT_KEY)) state.gastosOrder.push(CARGOS_CAT_KEY);
      recomputeGastoTotal(CARGOS_CAT_KEY);
    }
    const sig=JSON.stringify(cargoItems)+'|'+manual.length;
    if(sig!==_cargoSig){
      _cargoSig=sig;
      if(document.getElementById('gastos-body')) renderGastosTable('gastos-body');
      calcM1();
    }
  }
  function addDeudaRow(){
    const cnt=document.querySelectorAll('#deudas-body .multi-row').length;
    if(cnt>=15){showToast('Máximo 15 deudas','error');return;}
    const d={id:genDebtId(),nombre:'',saldo:0,cuota_mensual:0,tasa_anual:0,tipo:'CONSUMO_TARJETA'};
    state.deudas.push(d);
    addDeudaRowFromState(state.deudas.length-1);
  }
  
  function renderActivosTable(){
    // Gestiona SOLO las filas sincronizadas (fondo de estabilización de MVar y
    // fondo de provisiones de M5) dentro de state.activos. El inventario real de
    // bienes lo administra el módulo Mapa Patrimonial (window.MapaPatrimonial).

    // 1. Fondo de estabilización (módulo de variables)
    if(state.varIncome && state.varIncome.active){
      const idx = state.activos.findIndex(a => a.linkedToFondo);
      if(idx === -1){
        state.activos.unshift({
          nombre: 'Fondo de estabilización',
          valor: state.varIncome.fondoActual||0,
          tipo: 'LÍQUIDO',
          linkedToFondo: true
        });
      } else {
        state.activos[idx].valor = state.varIncome.fondoActual||0;
        state.activos[idx].nombre = 'Fondo de estabilización';
        state.activos[idx].tipo = 'LÍQUIDO';
        if(idx !== 0){
          const item = state.activos.splice(idx,1)[0];
          state.activos.unshift(item);
        }
      }
    } else {
      state.activos.forEach(a => { if(a.linkedToFondo) delete a.linkedToFondo; });
    }

    // 2. Fondo de provisiones (módulo M5) — solo si hay gastos anuales registrados
    const totalAnualP5 = state.p5.gastosAnual || 0;
    if(totalAnualP5 > 0 || (state.p5.fondoProvisiones||0) > 0){
      const idx = state.activos.findIndex(a => a.linkedToProvisiones);
      if(idx === -1){
        const insertAt = state.activos.findIndex(a => a.linkedToFondo) === 0 ? 1 : 0;
        state.activos.splice(insertAt, 0, {
          nombre: 'Fondo de provisiones',
          valor: state.p5.fondoProvisiones||0,
          tipo: 'LÍQUIDO',
          linkedToProvisiones: true
        });
      } else {
        state.activos[idx].valor = state.p5.fondoProvisiones||0;
        state.activos[idx].nombre = 'Fondo de provisiones';
        state.activos[idx].tipo = 'LÍQUIDO';
        const targetIdx = state.activos.findIndex(a => a.linkedToFondo) === 0 ? 1 : 0;
        if(idx !== targetIdx){
          const item = state.activos.splice(idx,1)[0];
          state.activos.splice(targetIdx, 0, item);
        }
      }
    } else {
      state.activos.forEach(a => { if(a.linkedToProvisiones) delete a.linkedToProvisiones; });
    }

    // Refrescar el inventario del Mapa Patrimonial (su propia UI)
    if(window.MapaPatrimonial && window.MapaPatrimonial.refresh){
      try { window.MapaPatrimonial.refresh(); } catch(e){ console.error(e); }
    }
  }
  function activoCells(a){
    return [
      `<div class="mr-field"><label>Valor de mercado</label><input class="money-input" data-f="valor" placeholder="0"></div>`,
      `<div class="mr-field"><label>Tipo</label><select data-f="tipo">
        <option value="LÍQUIDO" ${a.tipo==='LÍQUIDO'?'selected':''}>Líquido</option>
        <option value="NO LÍQUIDO" ${a.tipo==='NO LÍQUIDO'?'selected':''}>No líquido</option>
       </select></div>`,
      `<label class="mr-restringido" title="Fondos que no puedes usar libremente: pensión obligatoria, cesantías, etc."><input type="checkbox" data-f="restringido" ${a.restringido?'checked':''}><span>Restringido</span></label>`
    ].join('');
  }
  function addActivoRowFromState(i){
    const a=state.activos[i]||{nombre:'',valor:0,tipo:'NO LÍQUIDO'};
    const body=document.getElementById('activos-body');
  
    if(a.linkedToFondo){
      const row=document.createElement('div');
      row.className='multi-row multi-row-locked';
      row.innerHTML = '<div class="mr-head">'
        + '<div class="multi-locked-name">' + a.nombre + ' <span class="it-locked-badge">sincronizado</span></div>'
        + '<a href="#" class="it-locked-link" data-go-mvar>Ajustar saldo en módulo</a>'
        + '</div>'
        + '<div class="mr-grid">'
        + '<div class="mr-field locked"><label>Valor sincronizado</label><div class="locked-value">' + fmt(a.valor||0) + '</div></div>'
        + '<div class="mr-field locked"><label>Tipo</label><div class="locked-value">Líquido</div></div>'
        + '</div>';
      body.appendChild(row);
      const link = row.querySelector('[data-go-mvar]');
      if(link) link.addEventListener('click',function(e){e.preventDefault();navigateTo('var');});
      return;
    }
  
    if(a.linkedToProvisiones){
      const row=document.createElement('div');
      row.className='multi-row multi-row-locked';
      row.innerHTML = '<div class="mr-head">'
        + '<div class="multi-locked-name">' + a.nombre + ' <span class="it-locked-badge">sincronizado</span></div>'
        + '<a href="#" class="it-locked-link" data-go-prov>Ajustar saldo en gastos no periódicos</a>'
        + '</div>'
        + '<div class="mr-grid">'
        + '<div class="mr-field locked"><label>Valor sincronizado</label><div class="locked-value">' + fmt(a.valor||0) + '</div></div>'
        + '<div class="mr-field locked"><label>Tipo</label><div class="locked-value">Líquido</div></div>'
        + '</div>';
      body.appendChild(row);
      const link = row.querySelector('[data-go-prov]');
      if(link) link.addEventListener('click',function(e){e.preventDefault();navigateTo(5);});
      return;
    }
  
    const row=makeMultiRow(a,{cells:[activoCells(a)],namePlaceholder:'Nombre del activo'});
    body.appendChild(row);
    const vIn=row.querySelector('input[data-f=valor]'); vIn.value=a.valor>0?fmtInput(a.valor):'';attachMoneyInput(vIn);
    row.querySelectorAll('input,select').forEach(el=>{el.addEventListener('input',calcM3);if(el.tagName==='SELECT'||el.type==='checkbox')el.addEventListener('change',calcM3);});
    row.querySelector('.it-del').addEventListener('click',()=>{row.remove();calcM3();});
  }
  function addActivoRow(){
    const cnt=document.querySelectorAll('#activos-body .multi-row').length;
    if(cnt>=20){showToast('Máximo 20 activos','error');return;}
    state.activos.push({nombre:'',valor:0,tipo:'NO LÍQUIDO'});
    addActivoRowFromState(state.activos.length-1);
  }
  
  function renderAhorroTable(){
    const body=document.getElementById('ahorro-body');
    body.innerHTML='';
  
    // 1. Aporte al fondo de estabilización (módulo de variables)
    if(state.varIncome && state.varIncome.active){
      const idx = state.ahorro.findIndex(a => a.linkedToFondoAporte);
      const aporteSugerido = calcAporteFondoSugerido();
      if(idx === -1){
        state.ahorro.unshift({
          nombre: 'Aporte al fondo de estabilización',
          monto_mensual: aporteSugerido,
          linkedToFondoAporte: true,
          sugerido: aporteSugerido
        });
      } else {
        state.ahorro[idx].sugerido = aporteSugerido;
        if(idx !== 0){
          const item = state.ahorro.splice(idx,1)[0];
          state.ahorro.unshift(item);
        }
      }
    } else {
      state.ahorro.forEach(a => { if(a.linkedToFondoAporte) delete a.linkedToFondoAporte; });
    }
  
    // 2. Aporte al fondo de provisiones (módulo M5)
    const totalAnualP5 = state.p5.gastosAnual || 0;
    if(totalAnualP5 > 0){
      const idx = state.ahorro.findIndex(a => a.linkedToProvisionesAporte);
      const aporteProv = calcAporteProvisionesSugerido();
      if(idx === -1){
        // Insertar después del aporte de estabilización si existe
        const insertAt = state.ahorro.findIndex(a => a.linkedToFondoAporte) === 0 ? 1 : 0;
        state.ahorro.splice(insertAt, 0, {
          nombre: 'Aporte al fondo de provisiones',
          monto_mensual: aporteProv,
          linkedToProvisionesAporte: true,
          sugerido: aporteProv
        });
      } else {
        state.ahorro[idx].sugerido = aporteProv;
        const targetIdx = state.ahorro.findIndex(a => a.linkedToFondoAporte) === 0 ? 1 : 0;
        if(idx !== targetIdx){
          const item = state.ahorro.splice(idx,1)[0];
          state.ahorro.splice(targetIdx, 0, item);
        }
      }
    } else {
      state.ahorro.forEach(a => { if(a.linkedToProvisionesAporte) delete a.linkedToProvisionesAporte; });
    }
  
    state.ahorro.forEach((_,i)=>addAhorroRowFromState(i));
  }
  function calcAporteFondoSugerido(){
    const meta = getFondoMetaActual();
    const actual = state.varIncome.fondoActual||0;
    const faltante = Math.max(0, meta - actual);
    if(faltante<=0) return 0;
    return Math.ceil(faltante/18/50000)*50000;
  }
  function addAhorroRowFromState(i){
    const a=state.ahorro[i]||{nombre:'',monto_mensual:0};
    const monto = a.monto_mensual ?? a.monto ?? 0;
    const body=document.getElementById('ahorro-body');
    const row=document.createElement('div');
    row.className='item-row';
    row.style.gridTemplateColumns='1fr auto auto auto';
  
    if(a.linkedToFondoAporte || a.linkedToProvisionesAporte){
      row.classList.add('item-row-suggested');
      const sug = a.sugerido || 0;
      let sugLabel;
      if(a.linkedToFondoAporte){
        sugLabel = sug>0
          ? '<span class="it-suggest">Sugerido: ' + fmtInput(sug) + ' · cubre la meta en 18 meses</span>'
          : '<span class="it-suggest">Tu fondo ya está completo</span>';
      } else {
        sugLabel = sug>0
          ? '<span class="it-suggest">Sugerido: ' + fmtInput(sug) + ' · suma anual ÷ 12 meses</span>'
          : '<span class="it-suggest">No hay gastos anuales registrados</span>';
      }
      row.innerHTML = '<div class="it-name-wrap">'
        + '<input type="text" class="it-name" data-f="nombre" value="' + (a.nombre||'') + '" readonly>'
        + sugLabel
        + '<span class="it-precaucion-badge">Precaución</span>'
        + '</div>'
        + '<span class="it-prefix">' + currency + '</span>'
        + '<input class="money-input" data-f="monto">'
        + '<span class="it-empty"></span>';
      body.appendChild(row);
      const mIn=row.querySelector('.money-input');
      mIn.value=monto>0?fmtInput(monto):'';mIn.placeholder='0';
      attachMoneyInput(mIn);
      mIn.addEventListener('input',function(){
        a.monto_mensual = n(this.value);
        calcM4();
      });
      return;
    }
  
    row.innerHTML=`<div class="it-name-wrap">
        <input type="text" class="it-name" data-f="nombre" value="${(a.nombre||'').replace(/"/g,'&quot;')}" placeholder="Para qué ahorras">
        <label class="ahorro-precaucion" title="Colchón: emergencias, estabilización… no es inversión que hace crecer tu patrimonio"><input type="checkbox" data-f="precaucion" ${a.precaucion?'checked':''}><span>Precaución (colchón)</span></label>
      </div>
      <span class="it-prefix">${currency}</span>
      <input class="money-input" data-f="monto">
      <button class="it-del" title="Eliminar">${SVG_X}</button>`;
    body.appendChild(row);
    const mIn=row.querySelector('.money-input');
    mIn.value=monto>0?fmtInput(monto):'';mIn.placeholder='0';
    attachMoneyInput(mIn);
    row.querySelectorAll('input').forEach(el=>el.addEventListener('input',calcM4));
    row.querySelector('input[data-f=precaucion]')?.addEventListener('change',calcM4);
    row.querySelector('.it-del').addEventListener('click',()=>{
      if(state.ahorro.length<=1)return;
      state.ahorro.splice(i,1);renderAhorroTable();calcM4();
    });
  }
  function addAhorroRow(){
    if(state.ahorro.length>=12){showToast('Máximo 12 objetivos','error');return;}
    state.ahorro.push({nombre:'',monto_mensual:0});
    addAhorroRowFromState(state.ahorro.length-1);
  }
  
  /* ═══════════════════════════════════════════════════════════
     MÓDULO 5 — Presupuesto Anual
     ═══════════════════════════════════════════════════════════ */
  const P5_GASTO_CATS = [
    {id:'alimentacion',label:'Alimentación',items:['Mercado','Restaurantes','Domicilios']},
    {id:'vivienda',label:'Vivienda',items:[
      {nombre:'Arriendo / Hipoteca'},
      {nombre:'Administración'},
      {nombre:'Servicios públicos'},
      {nombre:'Internet / TV'},
      {nombre:'Predial', frec:'NO ES TODOS LOS MESES', mes:'02'},
      {nombre:'Servicio doméstico'}
    ]},
    {id:'transporte',label:'Transporte',items:[
      {nombre:'Gasolina'},
      {nombre:'Mantenimiento del vehículo'},
      {nombre:'Parqueaderos'},
      {nombre:'Transporte público'},
      {nombre:'Póliza de auto', frec:'NO ES TODOS LOS MESES', mes:''},
      {nombre:'Impuesto del vehículo', frec:'NO ES TODOS LOS MESES', mes:'05'}
    ]},
    {id:'salud',label:'Salud',items:['EPS / Medicina prepagada','Medicamentos','Consultas','Odontología']},
    {id:'educacion',label:'Educación',items:[
      {nombre:'Pensión mensual del colegio'},
      {nombre:'Matrícula del colegio', frec:'NO ES TODOS LOS MESES', mes:'01'},
      {nombre:'Útiles y uniformes', frec:'NO ES TODOS LOS MESES', mes:'01'},
      {nombre:'Cursos extracurriculares'}
    ]},
    {id:'comunicaciones',label:'Comunicaciones y ocio',items:['Plan celular','Streaming','Salidas / ocio']},
    {id:'vestuario',label:'Vestuario y cuidado',items:['Ropa','Peluquería','Cuidado personal']},
    {id:'mascotas',label:'Mascotas',items:['Alimento','Veterinario']},
    {id:'seguros',label:'Seguros y compromisos anuales', items:[
      {nombre:'Póliza de vida', frec:'NO ES TODOS LOS MESES', mes:''},
      {nombre:'Póliza de auto', frec:'NO ES TODOS LOS MESES', mes:''},
      {nombre:'Seguro de hogar', frec:'NO ES TODOS LOS MESES', mes:''},
      {nombre:'Medicina prepagada anual', frec:'NO ES TODOS LOS MESES', mes:''},
      {nombre:'Regalos y fechas especiales', frec:'NO ES TODOS LOS MESES', mes:'12'},
      {nombre:'Donaciones'}
    ]},
    {id:'otros_gastos',label:'Otros',items:['Otro']}
  ];

  /* Lista VIVA de categorías de gasto del Presupuesto Anual (editable/reordenable).
     Se siembra desde P5_GASTO_CATS la primera vez. */
  function p5Cats(){
    if(!Array.isArray(state.p5.gastoCats) || !state.p5.gastoCats.length){
      state.p5.gastoCats = P5_GASTO_CATS.map(c=>({id:c.id, label:c.label}));
    }
    return state.p5.gastoCats;
  }
  /* Items por defecto de una categoría semilla (para la primera carga) */
  function p5DefaultItems(catId){
    const c = P5_GASTO_CATS.find(x=>x.id===catId);
    return c ? c.items : [];
  }
  
  /* Plantillas pre-cargadas de ingresos no mensuales según tipo de cliente */
  function getP5IngresosPrecarga(tipo){
    if(tipo === 'empleado' || tipo === 'mixto'){
      return [
        {nombre:'Prima legal de mitad de año', frec:'NO ES TODOS LOS MESES', mes:'06', monto:0},
        {nombre:'Prima legal de fin de año', frec:'NO ES TODOS LOS MESES', mes:'12', monto:0},
        {nombre:'Cesantías (consignación a fondo)', frec:'NO ES TODOS LOS MESES', mes:'02', monto:0},
        {nombre:'Bonificación / participación de utilidades', frec:'NO ES TODOS LOS MESES', mes:'', monto:0},
        {nombre:'Devolución de retención en la fuente', frec:'NO ES TODOS LOS MESES', mes:'09', monto:0}
      ];
    }
    if(tipo === 'independiente'){
      return [
        {nombre:'Devolución de retención en la fuente', frec:'NO ES TODOS LOS MESES', mes:'09', monto:0},
        {nombre:'Dividendos de mi empresa', frec:'NO ES TODOS LOS MESES', mes:'', monto:0},
        {nombre:'Honorarios extraordinarios o bonos', frec:'NO ES TODOS LOS MESES', mes:'', monto:0}
      ];
    }
    return [];
  }
  
  function renderP5GastosAccordions(){
    const container=document.getElementById('p5-gastos-accordions');
    container.innerHTML='';
    p5Cats().forEach(cat=>{
      const saved=state.p5.gastos[cat.id]||[];
      const div=document.createElement('div');
      div.className='acc';
      div.dataset.acc=cat.id;
      div.innerHTML=`<div class="acc-head" onclick="toggleAcc(this)">
          <button class="p5-cat-drag" title="Arrastra para reordenar">${SVG_DRAG_HANDLE}</button>
          <input class="p5-cat-name" value="${String(cat.label||'').replace(/"/g,'&quot;')}" placeholder="Nombre de la categoría">
          <div class="acc-meta"><span id="acc-gas-${cat.id}-m">— mensual</span><span id="acc-gas-${cat.id}-a">— anual</span></div>
          <button class="p5-cat-del" title="Eliminar categoría">${SVG_X}</button>
          <div class="acc-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="6 9 12 15 18 9"/></svg></div>
        </div>
        <div class="acc-body">
          <div id="p5-gas-${cat.id}-body"></div>
          <button class="btn-add" onclick="addP5GastoRow('${cat.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Agregar gasto
          </button>
        </div>`;
      container.appendChild(div);

      if(saved.length>0) saved.forEach(item=>addP5GastoRowData(cat.id,item));
      else p5DefaultItems(cat.id).forEach(item=>{
        const data = typeof item === 'string'
          ? {nombre:item, frec:'TODOS LOS MESES', monto:0, mes:'', pertenece:'', obs:''}
          : Object.assign({nombre:'', frec:'TODOS LOS MESES', monto:0, mes:'', pertenece:'', obs:''}, item);
        addP5GastoRowData(cat.id, data);
      });

      // Nombre editable (no debe disparar el toggle del acordeón)
      const nameInp=div.querySelector('.p5-cat-name');
      ['click','pointerdown'].forEach(ev=>nameInp.addEventListener(ev,e=>e.stopPropagation()));
      nameInp.addEventListener('input',function(){
        const c=p5Cats().find(x=>x.id===cat.id); if(c) c.label=this.value;
        if(typeof scheduleSave==='function') scheduleSave('presupuesto_anual');
      });
      // Eliminar categoría
      const delBtn=div.querySelector('.p5-cat-del');
      delBtn.addEventListener('click',function(e){
        e.stopPropagation();
        showConfirm({
          title:'Eliminar categoría',
          msg:'¿Eliminar la categoría "'+(cat.label||'')+'" y todos sus gastos?',
          confirmText:'Eliminar', danger:true,
          onConfirm:function(){
            state.p5.gastoCats = p5Cats().filter(x=>x.id!==cat.id);
            if(state.p5.gastos) delete state.p5.gastos[cat.id];
            renderP5GastosAccordions(); calcP5Totals();
          }
        });
      });
      // Arrastrar categoría
      const dragH=div.querySelector('.p5-cat-drag');
      dragH.addEventListener('click',e=>e.stopPropagation());
      wireP5CatDrag(dragH, div, container);
    });

    // Botón agregar categoría
    const addCat=document.createElement('button');
    addCat.className='btn-add p5-add-cat';
    addCat.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Agregar categoría';
    addCat.addEventListener('click',function(){
      const id='gc_'+Date.now().toString(36)+Math.floor(Math.random()*1000).toString(36);
      p5Cats().push({id, label:'Nueva categoría'});
      if(!state.p5.gastos) state.p5.gastos={};
      state.p5.gastos[id]=[];
      renderP5GastosAccordions(); calcP5Totals();
      const ni=document.querySelector('.acc[data-acc="'+id+'"] .p5-cat-name');
      if(ni){ ni.focus(); ni.select(); }
    });
    container.appendChild(addCat);
  }

  /* Arrastre de CATEGORÍAS (acordeones) */
  function wireP5CatDrag(handle, accDiv, container){
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      e.preventDefault();
      accDiv.classList.add('p5-cat-dragging');
      document.body.style.userSelect='none'; document.body.style.cursor='grabbing';
      function move(ev){
        const sibs=Array.from(container.querySelectorAll('.acc:not(.p5-cat-dragging)'));
        let placed=false;
        for(const sib of sibs){ const r=sib.getBoundingClientRect(); if(ev.clientY < r.top+r.height/2){ container.insertBefore(accDiv, sib); placed=true; break; } }
        if(!placed){ const addB=container.querySelector('.p5-add-cat'); addB ? container.insertBefore(accDiv, addB) : container.appendChild(accDiv); }
      }
      function end(){
        document.removeEventListener('pointermove',move);
        document.removeEventListener('pointerup',end);
        document.removeEventListener('pointercancel',end);
        document.body.style.userSelect=''; document.body.style.cursor='';
        accDiv.classList.remove('p5-cat-dragging');
        const orden=Array.from(container.querySelectorAll('.acc')).map(a=>a.dataset.acc);
        const byId={}; p5Cats().forEach(c=>byId[c.id]=c);
        state.p5.gastoCats = orden.map(id=>byId[id]).filter(Boolean);
        if(typeof scheduleSave==='function') scheduleSave('presupuesto_anual');
      }
      document.addEventListener('pointermove',move);
      document.addEventListener('pointerup',end);
      document.addEventListener('pointercancel',end);
    });
  }

  /* Arrastre de GASTOS dentro de una categoría */
  function wireP5RowDrag(handle, rowDiv, body){
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      e.preventDefault();
      rowDiv.classList.add('p5-row-dragging');
      document.body.style.userSelect='none'; document.body.style.cursor='grabbing';
      function move(ev){
        const sibs=Array.from(body.querySelectorAll('.multi-row:not(.p5-row-dragging)'));
        let placed=false;
        for(const sib of sibs){ const r=sib.getBoundingClientRect(); if(ev.clientY < r.top+r.height/2){ body.insertBefore(rowDiv, sib); placed=true; break; } }
        if(!placed) body.appendChild(rowDiv);
      }
      function end(){
        document.removeEventListener('pointermove',move);
        document.removeEventListener('pointerup',end);
        document.removeEventListener('pointercancel',end);
        document.body.style.userSelect=''; document.body.style.cursor='';
        rowDiv.classList.remove('p5-row-dragging');
        calcP5Totals();   // recolecta el nuevo orden del DOM al estado y guarda
      }
      document.addEventListener('pointermove',move);
      document.addEventListener('pointerup',end);
      document.addEventListener('pointercancel',end);
    });
  }
  
  const MESES_OPCIONES = [
    {v:'',l:'— Selecciona el mes —'},
    {v:'01',l:'Enero'},{v:'02',l:'Febrero'},{v:'03',l:'Marzo'},{v:'04',l:'Abril'},
    {v:'05',l:'Mayo'},{v:'06',l:'Junio'},{v:'07',l:'Julio'},{v:'08',l:'Agosto'},
    {v:'09',l:'Septiembre'},{v:'10',l:'Octubre'},{v:'11',l:'Noviembre'},{v:'12',l:'Diciembre'},
    {v:'varia',l:'Varía año a año'}
  ];
  
  function p5Cells(d, sociosArr, opts){
    const s = sociosArr || getSocios();
    opts = opts || {};
    const isPoliza = !!opts.isPoliza;
    const isGasto  = !!opts.isGasto;  // sólo gastos muestran formaPago, yaEnM1, provisionar
    const frec = d.frec || 'TODOS LOS MESES';
    const isAnual = frec === 'NO ES TODOS LOS MESES';
    const provisionar = d.provisionar === undefined ? true : !!d.provisionar;
    const formaPago = d.formaPago || 'contado';
    const yaEnM1 = !!d.yaEnM1;
  
    let cells = [];
    cells.push('<div class="mr-field"><label>Frecuencia</label><select data-f="frec">'
      + '<option value="TODOS LOS MESES"'+(frec==='TODOS LOS MESES'?' selected':'')+'>Todos los meses</option>'
      + '<option value="NO ES TODOS LOS MESES"'+(frec==='NO ES TODOS LOS MESES'?' selected':'')+'>No todos los meses</option>'
      + '</select></div>');
    cells.push('<div class="mr-field"><label>Monto</label><input class="money-input" data-f="monto" placeholder="0"></div>');
  
    // Campo MES (visible solo si frecuencia no mensual)
    const mesOpts = MESES_OPCIONES.map(m=>'<option value="'+m.v+'"'+(d.mes===m.v?' selected':'')+'>'+m.l+'</option>').join('');
    const mesClass = isAnual ? 'mr-field' : 'mr-field hide';
    const mesValue = d.mes || '';
    const mesWarning = isAnual && !mesValue ? '<div class="field-warn">Selecciona el mes para activar el calendario</div>' : '';
    cells.push('<div class="'+mesClass+'" data-mes-cell><label>Mes esperado</label><select data-f="mes">'+mesOpts+'</select>'+mesWarning+'</div>');
  
    // Forma de pago, ya-en-M1 y provisionar — sólo aplican a gastos anuales
    if(isGasto){
      // Forma de pago (visible solo si anual)
      const formaPagoClass = isAnual ? 'mr-field' : 'mr-field hide';
      cells.push('<div class="'+formaPagoClass+'" data-forma-cell>'
        + '<label>Forma de pago</label>'
        + '<select data-f="formaPago">'
        + '<option value="contado"'+(formaPago==='contado'?' selected':'')+'>Anual al contado</option>'
        + '<option value="cuotas"'+(formaPago==='cuotas'?' selected':'')+'>Cuotas mensuales</option>'
        + '</select>'
        + '</div>');

      // Clasificación 50/30/20: Necesidad o Deseo (solo anual · alimenta la Regla de presupuesto)
      const bucketG = d.bucket || 'nec';
      const bucketGClass = isAnual ? 'mr-field' : 'mr-field hide';
      cells.push('<div class="'+bucketGClass+'" data-bucket-cell>'
        + '<label>En la regla 50/30/20 cuenta como</label>'
        + '<select data-f="bucket">'
        + '<option value="nec"'+(bucketG==='nec'?' selected':'')+'>Necesidad</option>'
        + '<option value="des"'+(bucketG==='des'?' selected':'')+'>Deseo</option>'
        + '</select>'
        + '</div>');
  
      // Pregunta "¿ya está en el M1?" (visible para cualquier gasto anual)
      const yaEnM1Visible = isAnual;
      const yaEnM1Class = yaEnM1Visible ? 'mr-field full ya-en-m1-cell' : 'mr-field full ya-en-m1-cell hide';
      cells.push('<div class="'+yaEnM1Class+'" data-ya-m1-cell>'
        + '<div class="ya-m1-row">'
        + '<label class="ya-m1-toggle">'
        + '<input type="checkbox" data-f="yaEnM1" ' + (yaEnM1?'checked':'') + '>'
        + '<span class="ya-m1-track"></span>'
        + '<span class="ya-m1-text">Ya lo registré como gasto mensual en Ingresos y Gastos</span>'
        + '</label>'
        + '</div>'
        + '<div class="ya-m1-hint">'
        + 'Marca esta casilla si este gasto ya está sumado en tus gastos del módulo de Ingresos y Gastos, '
        + 'para no contarlo dos veces. <strong>El gasto sigue contando como anual</strong> '
        + 'porque es un compromiso real, y se sugiere provisionar para no tener que financiarlo.'
        + '</div>'
        + '<div class="sobrecosto-info" data-sobrecosto>'
        + '</div>'
        + '</div>');
  
      // Toggle "Provisionar mensualmente" (visible solo si es anual)
      const provClass = isAnual ? 'mr-field provision-toggle-cell' : 'mr-field provision-toggle-cell hide';
      cells.push('<div class="'+provClass+'" data-prov-cell>'
        + '<label class="provision-toggle">'
        + '<input type="checkbox" data-f="provisionar" ' + (provisionar?'checked':'') + '>'
        + '<span class="provision-track"></span>'
        + '<span class="provision-text">Provisionar mensualmente</span>'
        + '</label>'
        + '<div class="provision-hint">Apartar mes a mes el equivalente</div>'
        + '</div>');
    }
  
    cells.push('<div class="mr-field"><label>Pertenece a</label><select data-f="pertenece">'
      + '<option value="">—</option>'
      + '<option value="socio1"'+(d.pertenece==='socio1'?' selected':'')+'>'+(s[0]||'Socio 01')+'</option>'
      + '<option value="socio2"'+(d.pertenece==='socio2'?' selected':'')+'>'+(s[1]||'Socio 02')+'</option>'
      + '<option value="ambos"'+(d.pertenece==='ambos'?' selected':'')+'>Ambos</option>'
      + '</select></div>');
  
    if(isPoliza){
      cells.push('<div class="mr-field"><label>Compañía actual</label><input type="text" data-f="compania" value="'+(d.compania||'')+'" placeholder="Ej: Sura, Bolívar"></div>');
    }
  
    cells.push('<div class="mr-field full"><label>Observaciones</label><input type="text" data-f="obs" value="'+(d.obs||'')+'" placeholder="Opcional"></div>');
  
    return cells.join('');
  }
  
  function wireP5Row(row, isPoliza){
    const mIn = row.querySelector('input[data-f=monto]');
    if(mIn){
      if(!mIn.value) mIn.value = '';
      if(!mIn.dataset.money) attachMoneyInput(mIn);
    }
    row.querySelectorAll('input,select').forEach(el=>{el.addEventListener('input',calcP5Totals);if(el.tagName==='SELECT')el.addEventListener('change',calcP5Totals);});
    row.querySelector('.it-del').addEventListener('click',function(){
      const doDelete=function(){ row.remove(); calcP5Totals(); };
      const nm=(row.querySelector('.it-name[data-f=nombre]')?.value||'').trim();
      const mt=n(row.querySelector('input[data-f=monto]')?.value);
      if(nm || mt>0){
        showConfirm({
          title:'Eliminar gasto',
          msg: nm ? ('¿Eliminar "'+nm+'"?') : '¿Eliminar este gasto?',
          confirmText:'Eliminar', danger:true, onConfirm:doDelete
        });
      } else doDelete();
    });
  
    const frecSel = row.querySelector('select[data-f=frec]');
    const mesCell = row.querySelector('[data-mes-cell]');
    const provCell = row.querySelector('[data-prov-cell]');
    const formaCell = row.querySelector('[data-forma-cell]');
    const bucketCell = row.querySelector('[data-bucket-cell]');
    const yaM1Cell = row.querySelector('[data-ya-m1-cell]');
    const formaSel = row.querySelector('select[data-f=formaPago]');
    const yaM1Input = row.querySelector('input[data-f=yaEnM1]');
    const sobrecostoEl = row.querySelector('[data-sobrecosto]');
  
    function refreshAnualUI(){
      const isAnual = frecSel && frecSel.value === 'NO ES TODOS LOS MESES';
      const isCuotas = formaSel && formaSel.value === 'cuotas';
  
      if(mesCell){
        if(isAnual) mesCell.classList.remove('hide');
        else {
          mesCell.classList.add('hide');
          const mesSel = mesCell.querySelector('select[data-f=mes]');
          if(mesSel) mesSel.value = '';
        }
      }
      if(provCell) isAnual ? provCell.classList.remove('hide') : provCell.classList.add('hide');
      if(formaCell) isAnual ? formaCell.classList.remove('hide') : formaCell.classList.add('hide');
      if(bucketCell) isAnual ? bucketCell.classList.remove('hide') : bucketCell.classList.add('hide');
      if(yaM1Cell){
        if(isAnual) yaM1Cell.classList.remove('hide');
        else yaM1Cell.classList.add('hide');
      }
  
      // Calcular y mostrar sobrecosto si paga en cuotas
      if(sobrecostoEl){
        if(isAnual && isCuotas){
          const monto = n(mIn?.value);
          if(monto > 0){
            // 12% de sobrecosto típico en pólizas financiadas
            const valorContado = Math.round(monto / 1.12);
            const sobrecosto = monto - valorContado;
            sobrecostoEl.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> '
              + 'Pagando en cuotas estás financiando aproximadamente <strong>' + fmt(sobrecosto) + ' al año</strong> en intereses '
              + '(esta póliza al contado costaría cerca de ' + fmt(valorContado) + '). '
              + 'Si provisionas mensualmente este año, el próximo vencimiento puedes pagarla al contado y ahorrar ese sobrecosto.';
            sobrecostoEl.style.display = 'block';
          } else {
            sobrecostoEl.style.display = 'none';
          }
        } else {
          sobrecostoEl.style.display = 'none';
        }
      }
  
      const mesSel = mesCell ? mesCell.querySelector('select[data-f=mes]') : null;
      const existing = mesCell ? mesCell.querySelector('.field-warn') : null;
      if(mesCell && isAnual && mesSel && !mesSel.value){
        if(!existing){
          const w = document.createElement('div');
          w.className = 'field-warn';
          w.textContent = 'Selecciona el mes para activar el calendario';
          mesCell.appendChild(w);
        }
      } else if(existing){
        existing.remove();
      }
    }
    if(frecSel) frecSel.addEventListener('change', refreshAnualUI);
    if(formaSel) formaSel.addEventListener('change', refreshAnualUI);
    const mesSel = mesCell ? mesCell.querySelector('select[data-f=mes]') : null;
    if(mesSel) mesSel.addEventListener('change', refreshAnualUI);
    // Re-calcular sobrecosto cuando cambia el monto
    if(mIn) mIn.addEventListener('input', refreshAnualUI);
    const provInput = row.querySelector('input[data-f=provisionar]');
    if(provInput){
      provInput.addEventListener('change', function(){
        calcP5Totals();
      });
    }
    if(yaM1Input){
      yaM1Input.addEventListener('change', function(){
        calcP5Totals();
      });
    }
    refreshAnualUI();
  }
  
  function addP5GastoRowData(catId,data){
    const body=document.getElementById('p5-gas-'+catId+'-body');
    if(!body) return;
    const isPoliza = catId === 'seguros';
    const row=makeMultiRow(data,{cells:[p5Cells(data,null,{isPoliza, isGasto:true})],namePlaceholder:'Concepto'});
    // Manejador de arrastre al inicio del encabezado de la fila
    const head=row.querySelector('.mr-head');
    if(head){
      const dh=document.createElement('button');
      dh.className='p5-row-drag';
      dh.title='Arrastra para reordenar';
      dh.innerHTML=SVG_DRAG_HANDLE;
      head.insertBefore(dh, head.firstChild);
      wireP5RowDrag(dh, row, body);
    }
    body.appendChild(row);
    const mIn=row.querySelector('input[data-f=monto]'); mIn.value=data.monto>0?fmtInput(data.monto):'';
    wireP5Row(row, isPoliza);
  }
  function addP5GastoRow(catId){addP5GastoRowData(catId,{nombre:'',frec:'TODOS LOS MESES',monto:0,mes:'',pertenece:'',obs:''});calcP5Totals();}
  
  function addP5Row(type){
    const body=document.getElementById('p5-'+type+'-body');
    const data={nombre:'',frec:'TODOS LOS MESES',monto:0,mes:'',pertenece:'',obs:''};
    const row=makeMultiRow(data,{cells:[p5Cells(data)],namePlaceholder:'Descripción'});
    body.appendChild(row);
    const mIn=row.querySelector('input[data-f=monto]');mIn.value='';
    wireP5Row(row, false);
  }
  function populateP5Section(bodyId,rows){
    const body=document.getElementById(bodyId);
    if(!body||!rows) return;
    body.innerHTML='';
    rows.forEach(d=>{
      const row=makeMultiRow(d,{cells:[p5Cells(d)],namePlaceholder:'Descripción'});
      body.appendChild(row);
      const mIn=row.querySelector('input[data-f=monto]'); mIn.value=d.monto>0?fmtInput(d.monto):'';
      wireP5Row(row, false);
    });
  }
  /* Pago de deudas (M5): espejo bloqueado y sincronizado desde el Módulo 2.
     La fuente única de la verdad es el M2; aquí solo se muestran sus cuotas. */
  function renderP5Deudas(){
    const body=document.getElementById('p5-deudas-body');
    if(!body) return;
    body.innerHTML='';
    const deudas=(state.deudas||[]).filter(d=>(d.cuota_mensual||0)>0);
    if(!deudas.length){
      body.innerHTML='<div class="p5-deudas-empty">Tus deudas se sincronizan automáticamente desde el módulo de <a href="#" data-go-m2>Endeudamiento</a>. Regístralas allí y sus cuotas mensuales aparecerán aquí, sin volver a digitarlas.</div>';
      const lnk=body.querySelector('[data-go-m2]');
      if(lnk) lnk.addEventListener('click',e=>{e.preventDefault();navigateTo(2);});
      return;
    }
    deudas.forEach(d=>{
      const row=document.createElement('div');
      row.className='multi-row multi-row-locked';
      row.innerHTML='<div class="mr-head">'
        +'<div class="multi-locked-name">'+(d.nombre||'Deuda')+' <span class="it-locked-badge">sincronizado</span></div>'
        +'<a href="#" class="it-locked-link" data-go-m2>Ajustar en Endeudamiento</a>'
        +'</div>'
        +'<div class="mr-grid">'
        +'<div class="mr-field locked"><label>Cuota mensual</label><div class="locked-value">'+fmt(d.cuota_mensual||0)+'</div></div>'
        +'<div class="mr-field locked"><label>Tasa anual</label><div class="locked-value">'+pct(d.tasa_anual||0)+'</div></div>'
        +'</div>';
      body.appendChild(row);
      const lnk=row.querySelector('[data-go-m2]');
      if(lnk) lnk.addEventListener('click',e=>{e.preventDefault();navigateTo(2);});
    });
  }
  function getSocios(){return [
    document.getElementById('socio1')?.value||'Socio 01',
    document.getElementById('socio2')?.value||'Socio 02'
  ];}
  function collectP5Rows(bodyId){
    const rows=[];
    document.querySelectorAll('#'+bodyId+' .multi-row').forEach(r=>{
      if(r.classList.contains('multi-row-locked')) return; // filas sincronizadas: no se recolectan
      const provInput = r.querySelector('input[data-f=provisionar]');
      const yaM1Input = r.querySelector('input[data-f=yaEnM1]');
      rows.push({
        nombre:r.querySelector('input[data-f=nombre]')?.value||'',
        frec:r.querySelector('select[data-f=frec]')?.value||'TODOS LOS MESES',
        monto:n(r.querySelector('input[data-f=monto]')?.value),
        mes:r.querySelector('select[data-f=mes]')?.value||'',
        formaPago:r.querySelector('select[data-f=formaPago]')?.value||'contado',
        yaEnM1: yaM1Input ? yaM1Input.checked : false,
        bucket: r.querySelector('select[data-f=bucket]')?.value || 'nec',
        provisionar: provInput ? provInput.checked : true,
        compania:r.querySelector('input[data-f=compania]')?.value||'',
        pertenece:r.querySelector('select[data-f=pertenece]')?.value||'',
        obs:r.querySelector('input[data-f=obs]')?.value||''
      });
    });
    return rows;
  }
  
  /* ═══════════════════════════════════════════════════════════
     TABLERO + CHARTS
     ═══════════════════════════════════════════════════════════ */
  let chartMensual=null,chartActivos=null,chartDeuda=null;
  let chartConcTipo=null,chartConcMoneda=null;
  let chartGeo=null,chartSector=null;
  
  function renderTablero(){
    const {totalIng,totalGas}=calcM1();
    const {totalDeuda,totalPagos,pagosConsumo,totConsumo,totApal,ratioConsumo,ratioApal}=calcM2();
    const {totalActivos,totalLiquido,totalNoLiquido,pctL,pctNL}=calcM3();
    const {totalAhorro}=calcM4();
    const ingresoAnual = totalIng*12 + (state.p5.ingAnual||0);
    // Abono extra mensual comprometido desde el simulador (capa reversible) → va a "Pago a deudas"
    const pd = state.tablero.planDeuda || {};
    const abonoExtraMensual = (pd.activo && pd.extraMensual > 0) ? pd.extraMensual : 0;
    const pagosConExtra = totalPagos + abonoExtraMensual;
    const pctAho = totalIng>0 ? totalAhorro/totalIng : 0;
    const pctDeu = totalIng>0 ? pagosConExtra/totalIng  : 0;
    const pctGas2= totalIng>0 ? totalGas/totalIng    : 0;
    const pctTotal = pctAho+pctDeu+pctGas2;
    const tbl=state.tablero;
  
    const exceso=document.getElementById('t6-aviso-exceso');
    if(pctTotal>1){
      exceso.innerHTML=`<div class="alert warn">${SVG_WARN}<div>La suma de gastos + deudas + ahorro supera el 100% de tus ingresos. Para sostenerlo tendrías que ajustar tus gastos.</div></div>`;
    } else exceso.innerHTML='';
  
    document.getElementById('t6-uso-mensual').innerHTML = `
      <div class="use-row head">
        <span>Concepto</span><span>Valor</span><span>%</span><span>Mi meta</span>
      </div>
      ${useRow('Ingresos mensuales', totalIng, 1, tbl.meta_ingresos, 'meta_ingresos', true)}
      ${useRow('Ahorro mensual',     totalAhorro, pctAho, tbl.meta_ahorro,  'meta_ahorro')}
      ${useRow('Pago a deudas',      pagosConExtra,  pctDeu, tbl.meta_deudas,  'meta_deudas')}
      ${abonoExtraMensual>0 ? '<div class="use-row-note">Incluye '+fmt(abonoExtraMensual)+' de abono extra a deuda de tu simulador</div>' : ''}
      ${useRow('Gastos mensuales',   totalGas,    pctGas2,tbl.meta_gastos,  'meta_gastos')}
      <div class="use-row total">
        <span class="ur-name"><strong>Total</strong></span>
        <span class="ur-amount">${fmt(totalAhorro+pagosConExtra+totalGas)}</span>
        <span class="ur-pct">${pct(pctTotal)}</span>
        <span></span>
      </div>`;
    bindMetaInputs();
  
    const ingAnual=state.p5.ingAnual||0;
    const ahoAnual=state.p5.ahoAnual||0;
    const deuAnual=state.p5.deuAnual||0;
    const gasAnual=state.p5.gastosAnual||0;
    const pdA = state.tablero.planDeuda || {};
    const abonoExt = (pdA.activo && pdA.abono && pdA.abono.monto > 0) ? pdA.abono : null;
    let anualHtml = `
      <div class="use-row head"><span>Concepto</span><span>Valor</span><span>%</span><span>Mi meta</span></div>
      ${useRow('Otros ingresos',    ingAnual, ingresoAnual>0?ingAnual/ingresoAnual:0, tbl.meta_otros_ingresos,'meta_otros_ingresos')}
      ${useRow('Otro ahorro',       ahoAnual, ingresoAnual>0?ahoAnual/ingresoAnual:0, tbl.meta_otro_ahorro,   'meta_otro_ahorro')}
      ${useRow('Otros pagos deuda', deuAnual, ingresoAnual>0?deuAnual/ingresoAnual:0, tbl.meta_otros_deudas,  'meta_otros_deudas')}
      ${useRow('Otros gastos',      gasAnual, ingresoAnual>0?gasAnual/ingresoAnual:0, tbl.meta_otros_gastos,  'meta_otros_gastos')}`;
    if(abonoExt){
      const esAhorro = abonoExt.fuente === 'ahorro';
      const fuenteLinea = esAhorro ? 'Traslado desde tus ahorros (financia el abono)' : 'Ingreso nuevo / prima (financia el abono)';
      const fuenteTxt   = esAhorro ? 'un traslado de tus ahorros' : 'una prima o ingreso nuevo';
      anualHtml += `
        <div class="use-row plan-extra"><span class="ur-name">Abono extraordinario a deuda · mes ${abonoExt.mes}</span><span class="ur-amount">${fmt(abonoExt.monto)}</span><span class="ur-pct"></span><span></span></div>
        <div class="use-row plan-extra"><span class="ur-name">${fuenteLinea}</span><span class="ur-amount">+${fmt(abonoExt.monto)}</span><span class="ur-pct"></span><span></span></div>
        <div class="use-row-note">Tu plan incluye un abono extraordinario de ${fmt(abonoExt.monto)} en el mes ${abonoExt.mes}, financiado con ${fuenteTxt}. Al estar financiado, no cambia tu saldo anual proyectado.</div>`;
    }
    document.getElementById('t6-anuales').innerHTML = anualHtml;
    bindMetaInputs();
  
    const saldo=state.p5.saldo||0;
    document.getElementById('t6-saldo-anual').innerHTML = saldo>=0
      ? `<div class="alert pos">${SVG_CHECK}<div>Saldo anual positivo: <strong>${fmt(saldo)}</strong> — Tu presupuesto cierra bien.</div></div>`
      : `<div class="alert neg">${SVG_WARN}<div>Saldo anual negativo: <strong>${fmt(saldo)}</strong> — Ajusta ingresos, gastos o ahorro.</div></div>`;
  
    /* Indicators */
    const solvencia  = totalDeuda>0 ? totalActivos/totalDeuda : 0;
    const totalGastosM = Object.values(state.gastos).reduce((a,b)=>a+b,0);
    const fondoEmerg = totalGastosM>0 ? totalLiquido/totalGastosM : 0;
    const pctConsumoIng = totalIng>0 ? pagosConsumo/totalIng : 0;
  
    const indicators=[
      {label:'Pagos a deuda de consumo',desc:'% del ingreso mensual en cuotas de consumo',val:pct(pctConsumoIng),bar:Math.min(pctConsumoIng/.5,1),color:pctConsumoIng<.2?'var(--pos)':pctConsumoIng<.3?'var(--warn)':'var(--neg)',metaKey:'meta_consumo',meta:tbl.meta_consumo||0,money:true},
      {label:'Deuda total',desc:'Saldo agregado de tus deudas',val:fmt(totalDeuda),bar:0,color:'var(--accent)',metaKey:'meta_deuda_total',meta:tbl.meta_deuda_total||0,money:true},
      {label:'Ratio deuda consumo',desc:'% de tu deuda total que es de consumo (meta &lt;40%)',val:pct(ratioConsumo),bar:Math.min(ratioConsumo,1),color:ratioConsumo<.4?'var(--pos)':ratioConsumo<.6?'var(--warn)':'var(--neg)',metaKey:'meta_ratio_consumo',meta:tbl.meta_ratio_consumo||0},
      {label:'Ratio apalancamiento',tipKey:'apalancamiento',desc:'% de tu deuda total que genera activos (más es mejor)',val:pct(ratioApal),bar:Math.min(ratioApal,1),color:ratioApal>.5?'var(--pos)':ratioApal>.25?'var(--warn)':'var(--neg)',metaKey:'meta_ratio_apal',meta:tbl.meta_ratio_apal||0},
      {label:'% Activos líquidos',tipKey:'activo_liquido',desc:'Activos convertibles fácilmente en dinero',val:pct(pctL),bar:pctL,color:pctL>.3?'var(--pos)':'var(--warn)',metaKey:'meta_pct_liquidos',meta:tbl.meta_pct_liquidos||0},
      {label:'Fondo de emergencias',tipKey:'fondo_emergencias',desc:'Meses de gastos cubiertos · meta &gt;6',val:fondoEmerg.toFixed(1)+' meses',bar:Math.min(fondoEmerg/12,1),color:fondoEmerg>6?'var(--pos)':fondoEmerg>=3?'var(--warn)':'var(--neg)',metaKey:'meta_fondo_emerg',meta:tbl.meta_fondo_emerg||0},
      {label:'Nivel de solvencia',desc:'Veces que activos cubren deudas · meta &gt;1',val:solvencia.toFixed(2)+'×',bar:Math.min(solvencia/3,1),color:solvencia>1.5?'var(--pos)':solvencia>=1?'var(--warn)':'var(--neg)',metaKey:'meta_solvencia',meta:tbl.meta_solvencia||0}
    ];
  
    // Indicadores adicionales del M5 (presupuesto anual)
    const totalGastosAnualesM5 = state.p5.gastosAnual || 0;
    const totalIngresosM = state.p5.ingMensual || 0;
    if(totalGastosAnualesM5 > 0 || totalIngresosM > 0){
      // Costo de vida real = gastos mensuales (M1) + provisión mensual de gastos anuales (M5/12)
      const provisionMensual = totalGastosAnualesM5 / 12;
      const costoVidaReal = totalGastosM + provisionMensual;
      const sobreingreso = totalIng > 0 ? costoVidaReal/totalIng : 0;
      indicators.push({
        label:'Costo de vida real', tipKey:'costo_vida_real',
        desc:'Gastos mensuales + provisión mensual de gastos anuales · ' + (sobreingreso<0.7?'sostenible':sobreingreso<0.9?'ajustado':'comprometido'),
        val:fmt(costoVidaReal),
        bar:Math.min(sobreingreso,1),
        color:sobreingreso<0.7?'var(--pos)':sobreingreso<0.9?'var(--warn)':'var(--neg)',
        metaKey:'meta_costo_vida_real',meta:tbl.meta_costo_vida_real||0,money:true
      });
  
      // Índice de previsión = saldo provisiones / gastos próximos 90 días
      const proximos90 = (function(){
        const hoy = new Date();
        const mesActual = hoy.getMonth() + 1;
        const mesesProximos = [];
        for(let i=0;i<3;i++){
          const m = ((mesActual - 1 + i) % 12) + 1;
          mesesProximos.push(String(m).padStart(2,'0'));
        }
        let total = 0;
        p5Cats().forEach(cat=>{
          document.querySelectorAll('#p5-gas-'+cat.id+'-body .multi-row').forEach(r=>{
            const frec = r.querySelector('select[data-f=frec]')?.value;
            const mes  = r.querySelector('select[data-f=mes]')?.value;
            const monto = n(r.querySelector('input[data-f=monto]')?.value);
            if(frec === 'NO ES TODOS LOS MESES' && mesesProximos.includes(mes)) total += monto;
          });
        });
        return total;
      })();
      const saldoProv = state.p5.fondoProvisiones || 0;
      const indicePrev = proximos90 > 0 ? Math.min(saldoProv/proximos90, 1) : 1;
      if(proximos90 > 0){
        indicators.push({
          label:'Índice de previsión', tipKey:'indice_prevision',
          desc:'% de gastos anuales próximos a vencer ya provisionados · meta 100%',
          val:pct(indicePrev),
          bar:indicePrev,
          color:indicePrev>=0.9?'var(--pos)':indicePrev>=0.6?'var(--warn)':'var(--neg)',
          metaKey:'meta_indice_prev',meta:tbl.meta_indice_prev||0
        });
      }
  
      // Saldo proyectado de fin de año (basado en M5)
      const saldoAnual = state.p5.saldo || 0;
      indicators.push({
        label:'Saldo proyectado fin de año',
        desc:'Resultado neto de tus gastos no periódicos · ingresos − gastos − ahorros − deudas',
        val:fmt(saldoAnual),
        bar:saldoAnual >= 0 ? 1 : 0,
        color:saldoAnual>=0?'var(--pos)':'var(--neg)',
        metaKey:'meta_saldo_anual',meta:tbl.meta_saldo_anual||0,money:true
      });
    }
  
    // Indicadores adicionales si MVar activo
    if(state.varIncome && state.varIncome.active){
      const v = state.varIncome;
      const mesesConDatos = getCombinedMeses().filter(m=>(m.bruto||0)>0);
      const netos = mesesConDatos.map(m=>m.neto||0);
  
      if(netos.length>=3){
        const promNeto = vMean(netos);
        const variabilidad = promNeto>0 ? vStdDev(netos)/promNeto : 0;
        const salarioP = getSalarioPersonalActual();
        const metaFondo = getFondoMetaActual();                 // z·σ·√L
        const fondoPct = metaFondo>0 ? Math.min(v.fondoActual/metaFondo,1) : 0;
  
        indicators.push({
          label:'Variabilidad de tu ingreso', tipKey:'variabilidad',
          desc:'Cuánto cambia tu ingreso mes a mes · ' + (variabilidad<0.25?'estable':variabilidad<0.5?'variable':'muy volátil'),
          val:pct(variabilidad),bar:Math.min(variabilidad/.7,1),
          color:variabilidad<0.25?'var(--pos)':variabilidad<0.5?'var(--warn)':'var(--neg)',
          metaKey:'meta_variabilidad',meta:tbl.meta_variabilidad||0
        });
        indicators.push({
          label:'Fondo de estabilización', tipKey:'fondo_estabilizacion',
          desc:'Colchón para suavizar tu variabilidad · meta '+fmt(metaFondo),
          val:metaFondo>0?pct(fondoPct):'—',bar:fondoPct,
          color:fondoPct>=1?'var(--pos)':fondoPct>=0.5?'var(--warn)':'var(--neg)',
          metaKey:'meta_fondo_estab',meta:tbl.meta_fondo_estab||0,money:true
        });
  
        const cumplenSal = netos.filter(x=>x>=salarioP).length;
        const sostenibilidad = netos.length>0 ? cumplenSal/netos.length : 0;
        if(salarioP>0){
          indicators.push({
            label:'Sostenibilidad del salario personal', tipKey:'salario_personal',
            desc:'% de meses históricos donde tu ingreso supera tu salario fijo · meta &gt;75%',
            val:pct(sostenibilidad),bar:sostenibilidad,
            color:sostenibilidad>=0.75?'var(--pos)':sostenibilidad>=0.6?'var(--warn)':'var(--neg)',
            metaKey:'meta_sostenibilidad',meta:tbl.meta_sostenibilidad||0
          });
        }
      }
  
      let totalDebido=0, totalReservado=0;
      getCombinedMeses().forEach(m=>{
        totalDebido    += m.tributoSugerido || 0;
        totalReservado += m.tributo || 0;
      });
      const deficit = Math.max(0, totalDebido - totalReservado);
      const cobTrib = totalDebido>0 ? totalReservado/totalDebido : 1;
      indicators.push({
        label:'Reserva tributaria', tipKey:'reserva_tributaria',
        desc:'Cobertura sobre lo que debiste apartar · ' + (deficit>0?'déficit '+fmt(deficit):'al día'),
        val:pct(cobTrib),bar:Math.min(cobTrib,1),
        color:cobTrib>=1?'var(--pos)':cobTrib>=0.7?'var(--warn)':'var(--neg)',
        metaKey:'meta_reserva_trib',meta:tbl.meta_reserva_trib||0
      });
    }
  
    document.getElementById('t6-indicadores').innerHTML = indicators.map((ind,i)=>`
      <div class="ind-row">
        <div>
          <div class="ind-name">${ind.label}${ind.tipKey?(' '+tip(ind.tipKey)):''}</div>
          <div class="ind-desc">${ind.desc}</div>
        </div>
        <div class="ind-val">${ind.val}</div>
        <div class="ind-bar"><div class="ind-bar-fill" style="width:${Math.max(0,Math.min(100,ind.bar*100))}%;background:${ind.color}"></div></div>
        <div class="ind-meta">
          <span class="ind-meta-label">Mi meta</span>
          <input class="ind-meta-input ${ind.money?'money-input':''}" data-meta-key="${ind.metaKey}" placeholder="0">
        </div>
      </div>`).join('');
  
    // Initialize meta input values + handlers
    document.querySelectorAll('.ind-meta-input').forEach(inp=>{
      const key=inp.dataset.metaKey;
      const val=tbl[key]||0;
      if(inp.classList.contains('money-input')){
        inp.value = val>0 ? fmtInput(val) : '';
        attachMoneyInput(inp);
        inp.addEventListener('input',()=>{state.tablero[key]=n(inp.value);scheduleSave('tablero');});
      } else {
        inp.value = val||'';
        inp.addEventListener('input',()=>{state.tablero[key]=parseFloat(inp.value)||0;scheduleSave('tablero');});
      }
    });
  
    /* Objectives */
    const cols=[{title:'A 30 días',start:0},{title:'A 90 días',start:5},{title:'A 360 días',start:10}];
    document.getElementById('t6-objetivos').innerHTML = cols.map(col=>`
      <div>
        <div class="obj-col-title">${col.title}</div>
        ${Array.from({length:5},(_,j)=>{const idx=col.start+j;return`<textarea class="obj-input" placeholder="Objetivo ${idx+1}" data-obj-idx="${idx}">${tbl.objetivos[idx]||''}</textarea>`;}).join('')}
      </div>`).join('');
    document.querySelectorAll('.obj-input').forEach(ta=>{
      ta.addEventListener('input',()=>{state.tablero.objetivos[parseInt(ta.dataset.objIdx)]=ta.value;scheduleSave('tablero');});
    });
  
    document.getElementById('t6-plan').value = tbl.plan||'';
    document.getElementById('t6-plan').oninput = function(){state.tablero.plan=this.value;scheduleSave('tablero');};
    const planClear = document.getElementById('t6-plan-clear');
    if(planClear) planClear.onclick = function(){
      const ta = document.getElementById('t6-plan');
      if(!ta || !(ta.value||'').trim()){ showToast('El plan ya está vacío','info'); return; }
      showConfirm({
        title:'Limpiar plan de acción',
        msg:'¿Borrar todo el contenido de tu plan de acción? Esta acción no se puede deshacer.',
        confirmText:'Limpiar', danger:true,
        onConfirm:function(){
          ta.value=''; state.tablero.plan=''; scheduleSave('tablero');
          showToast('Plan de acción limpiado','success');
        }
      });
    };
    renderTableroSimulador();
    renderBudgetRule();
    renderCouple();
  }
  
  function useRow(name, value, pctValue, meta, metaKey, isHead){
    return `<div class="use-row${isHead?' head':''}" style="${isHead?'background:var(--surface-soft);font-weight:600':''}">
      <span class="ur-name">${isHead?'<strong>'+name+'</strong>':name}</span>
      <span class="ur-amount">${isHead?'<strong>'+fmt(value)+'</strong>':fmt(value)}</span>
      <span class="ur-pct">${pct(pctValue)}</span>
      <span class="ur-meta"><span class="ur-meta-label">Meta</span><input class="ur-meta-input money-input" data-meta-key="${metaKey}" placeholder="0"></span>
    </div>`;
  }
  
  function bindMetaInputs(){
    document.querySelectorAll('.ur-meta-input').forEach(inp=>{
      const key=inp.dataset.metaKey;
      if(!key||inp.dataset.bound)return;
      inp.dataset.bound='1';
      const val=state.tablero[key]||0;
      inp.value = val>0 ? fmtInput(val) : '';
      attachMoneyInput(inp);
      inp.addEventListener('input',()=>{state.tablero[key]=n(inp.value);scheduleSave('tablero');});
    });
  }
  
  function renderCharts(){
    const {totalIng,totalGas}=calcM1();
    const {totalPagos,totConsumo,totApal}=calcM2();
    const {totalLiquido,totalNoLiquido}=calcM3();
    const {totalAhorro}=calcM4();
    const libre=Math.max(0,totalIng-totalAhorro-totalPagos-totalGas);
    const totOtroD=Math.max(0,state.deudas.reduce((a,d)=>a+d.saldo,0)-totConsumo-totApal);
  
    const C={
      ink:'#0c0c0d',
      accent:'#0e4d3a',
      accent2:'#1a6b54',
      pos:'#0e4d3a',
      posLt:'#5a8a73',
      neg:'#8a1f1c',
      negLt:'#bf6663',
      warn:'#8a5a14',
      neutral:'#a8a59e',
      border:'#fff'
    };
    const opts = {
      responsive:true,maintainAspectRatio:true,
      plugins:{
        legend:{position:'bottom',labels:{font:{family:'Geist',size:11,weight:'500'},boxWidth:10,boxHeight:10,padding:14,color:'#2b2b2e',usePointStyle:true,pointStyle:'circle'}},
        tooltip:{
          backgroundColor:'#0c0c0d',titleColor:'#fff',bodyColor:'#fff',
          padding:12,cornerRadius:10,displayColors:false,
          titleFont:{family:'Geist',weight:'600',size:12},
          bodyFont:{family:'JetBrains Mono',size:12},
          callbacks:{label:ctx=>' '+fmt(ctx.parsed)}
        }
      }
    };
  
    if(chartMensual) chartMensual.destroy();
    chartMensual=new Chart(document.getElementById('chart-donut-mensual').getContext('2d'),{
      type:'doughnut',
      data:{
        labels:['Ahorro','Deudas','Gastos','Libre'],
        datasets:[{data:[totalAhorro,totalPagos,totalGas,libre],
          backgroundColor:[C.accent,C.neg,C.ink,C.posLt],
          borderWidth:3,borderColor:C.border,hoverOffset:8,borderRadius:2}]
      },
      options:{...opts,cutout:'70%'}
    });
  
    if(chartActivos) chartActivos.destroy();
    chartActivos=new Chart(document.getElementById('chart-donut-activos').getContext('2d'),{
      type:'doughnut',
      data:{
        labels:['Líquidos','No líquidos'],
        datasets:[{data:[totalLiquido,totalNoLiquido],
          backgroundColor:[C.accent,C.warn],
          borderWidth:3,borderColor:C.border,hoverOffset:8}]
      },
      options:{...opts,cutout:'70%'}
    });
  
    if(chartDeuda) chartDeuda.destroy();
    chartDeuda=new Chart(document.getElementById('chart-donut-deuda').getContext('2d'),{
      type:'doughnut',
      data:{
        labels:['Consumo','Apalancamiento','Otro'],
        datasets:[{data:[totConsumo,totApal,totOtroD],
          backgroundColor:[C.neg,C.accent,C.neutral],
          borderWidth:3,borderColor:C.border,hoverOffset:8}]
      },
      options:{...opts,cutout:'70%'}
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD PATRIMONIAL — Fase 2: bloques base (Mapa de Activos)
  // ═══════════════════════════════════════════════════════════
  function getMapaData(){
    try { return (window.MapaPatrimonial && window.MapaPatrimonial.getData) ? window.MapaPatrimonial.getData() : null; }
    catch(e){ return null; }
  }

  function renderDashboardPatrimonio(){
    const data = getMapaData();
    const section = document.getElementById('db-patrimonio-section');
    if(!section) return;
    const empty = document.getElementById('db-patrimonio-empty');
    const activos = (data && data.activosNormalizados) ? data.activosNormalizados : [];
    const r = (data && data.resumen) ? data.resumen : null;

    // Estado vacío
    if(!activos.length || !r){
      if(empty) empty.style.display = 'block';
      document.getElementById('db-patrimonio-neto').textContent = fmt(0);
      document.getElementById('db-activos-brutos').textContent = fmt(0);
      document.getElementById('db-deudas-total').textContent = fmt(0);
      document.getElementById('db-patrimonio-detalle').textContent = '';
      document.getElementById('db-patrimonio-crecimiento').textContent = '';
      document.getElementById('db-activos-count').textContent = '';
      const liqCard = document.getElementById('db-liquidez-card');
      if(liqCard) liqCard.style.display = 'none';
      if(chartConcTipo){ chartConcTipo.destroy(); chartConcTipo=null; }
      if(chartConcMoneda){ chartConcMoneda.destroy(); chartConcMoneda=null; }
      return;
    }
    if(empty) empty.style.display = 'none';
    document.getElementById('db-liquidez-card').style.display = '';

    // ── Bloque 1: Patrimonio neto ──
    document.getElementById('db-patrimonio-neto').textContent = fmt(r.patrimonioNetoCOP);
    const usdEl = document.getElementById('db-patrimonio-usd');
    if (usdEl) {
      if (r.trmUSD && r.trmUSD > 0) {
        const enUSD = r.patrimonioNetoCOP / r.trmUSD;
        usdEl.textContent = '≈ USD ' + enUSD.toLocaleString('en-US', {maximumFractionDigits: 0});
        usdEl.style.display = 'block';
      } else {
        usdEl.style.display = 'none';
      }
    }
    document.getElementById('db-activos-brutos').textContent = fmt(r.patrimonioBrutoCOP);
    document.getElementById('db-deudas-total').textContent = fmt(r.deudaTotalCOP);
    document.getElementById('db-activos-count').textContent =
      r.cantidadBienes + (r.cantidadBienes === 1 ? ' activo registrado' : ' activos registrados');
    const det = document.getElementById('db-patrimonio-detalle');
    det.textContent = 'Activos ' + fmt(r.patrimonioBrutoCOP) + ' − deudas ' + fmt(r.deudaTotalCOP);
    // Valorización (solo si hay ganancia real registrada)
    const grow = document.getElementById('db-patrimonio-crecimiento');
    if(r.gananciaAcumuladaCOP && r.gananciaAcumuladaCOP > 0){
      grow.textContent = '↗ Tus activos con historial han ganado ' + fmt(r.gananciaAcumuladaCOP) + ' desde que los adquiriste';
      grow.style.display = 'block';
    } else {
      grow.style.display = 'none';
    }

    // ── Bloque 4: Liquidez (meses de respaldo) ──
    let gastoMensual = 0;
    try { gastoMensual = (calcM1().totalGas) || 0; } catch(e){ gastoMensual = 0; }
    const liquidoCOP = activos.filter(a => a.tipo === 'LÍQUIDO' && !a.restringido).reduce((s,a)=>s+a.valor,0);
    const liqMesesEl = document.getElementById('db-liquidez-meses');
    const liqFraseEl = document.getElementById('db-liquidez-frase');
    const liqBar = document.getElementById('db-liquidez-bar');
    if(gastoMensual > 0){
      const meses = liquidoCOP / gastoMensual;
      liqMesesEl.textContent = (meses >= 24 ? '24+' : meses.toFixed(1)) + (meses === 1 ? ' mes' : ' meses');
      let frase, cls;
      if(meses < 3){ frase = 'Por debajo del colchón recomendado de 3 a 6 meses. Conviene reforzar tu liquidez.'; cls='neg'; }
      else if(meses < 6){ frase = 'Vas bien. Estás dentro del rango recomendado de 3 a 6 meses.'; cls='warn'; }
      else { frase = 'Excelente colchón de liquidez: cubres más de 6 meses de gastos.'; cls='pos'; }
      liqFraseEl.textContent = frase;
      liqFraseEl.className = 'db-liquidez-frase ' + cls;
      const pct = Math.min(100, (meses / 6) * 100);
      liqBar.style.width = pct + '%';
      liqBar.className = 'db-bar-fill ' + cls;
    } else {
      liqMesesEl.textContent = '—';
      liqFraseEl.textContent = 'Registra tus gastos en el Módulo 1 para calcular cuántos meses cubres con tu liquidez.';
      liqFraseEl.className = 'db-liquidez-frase';
      liqBar.style.width = '0%';
    }

    // ── Bloques 2 y 3: concentración por tipo y moneda ──
    renderConcentracionCharts(activos, r.patrimonioBrutoCOP);
  }

  function renderConcentracionCharts(activos, totalBruto){
    const C={ accent:'#0e4d3a', accent2:'#1a6b54', accent3:'#5a8a73', warn:'#8a5a14', neg:'#8a1f1c', neutral:'#a8a59e', gold:'#b08d2e', blue:'#2b5f7a', border:'#fff' };
    const palette=[C.accent,C.warn,C.accent2,C.neg,C.blue,C.accent3,C.gold,C.neutral];
    const opts={responsive:true,maintainAspectRatio:true,plugins:{
      legend:{position:'bottom',labels:{font:{family:'Geist',size:11,weight:'500'},boxWidth:10,boxHeight:10,padding:14,color:'#2b2b2e',usePointStyle:true,pointStyle:'circle'}},
      tooltip:{backgroundColor:'#0c0c0d',titleColor:'#fff',bodyColor:'#fff',padding:12,cornerRadius:10,displayColors:false,
        titleFont:{family:'Geist',weight:'600',size:12},bodyFont:{family:'JetBrains Mono',size:12},
        callbacks:{label:ctx=>' '+fmt(ctx.parsed)+' ('+(totalBruto>0?Math.round(ctx.parsed/totalBruto*100):0)+'%)'}}
    }};

    // Agrupar por categoría
    const porTipo = {};
    activos.forEach(a => { porTipo[a._categoria] = (porTipo[a._categoria]||0) + a.valor; });
    const tipoLabels = Object.keys(porTipo);
    const tipoData = tipoLabels.map(k => porTipo[k]);

    if(chartConcTipo) chartConcTipo.destroy();
    chartConcTipo = new Chart(document.getElementById('chart-concentracion-tipo').getContext('2d'),{
      type:'doughnut',
      data:{labels:tipoLabels,datasets:[{data:tipoData,backgroundColor:palette,borderWidth:3,borderColor:C.border,hoverOffset:8}]},
      options:{...opts,cutout:'62%'}
    });
    // Frase: el tipo más concentrado
    const fraseTipoEl = document.getElementById('frase-concentracion-tipo');
    if(tipoLabels.length && totalBruto>0){
      let maxK=tipoLabels[0],maxV=tipoData[0];
      tipoData.forEach((v,i)=>{ if(v>maxV){maxV=v;maxK=tipoLabels[i];} });
      const pct=Math.round(maxV/totalBruto*100);
      fraseTipoEl.textContent = pct>=60
        ? `El ${pct}% de tu patrimonio está en ${maxK}. Es una concentración alta; diversificar reduce riesgo.`
        : `Tu mayor concentración es ${maxK} con el ${pct}% del patrimonio.`;
    } else { fraseTipoEl.textContent=''; }

    // Agrupar por moneda
    const porMoneda = {};
    activos.forEach(a => { const m=a._moneda||'COP'; porMoneda[m]=(porMoneda[m]||0)+a.valor; });
    const monLabels = Object.keys(porMoneda);
    const monData = monLabels.map(k => porMoneda[k]);

    if(chartConcMoneda) chartConcMoneda.destroy();
    chartConcMoneda = new Chart(document.getElementById('chart-concentracion-moneda').getContext('2d'),{
      type:'doughnut',
      data:{labels:monLabels,datasets:[{data:monData,backgroundColor:palette,borderWidth:3,borderColor:C.border,hoverOffset:8}]},
      options:{...opts,cutout:'62%'}
    });
    const fraseMonEl = document.getElementById('frase-concentracion-moneda');
    if(monLabels.length===1 && monLabels[0]==='COP'){
      fraseMonEl.textContent = 'Todo tu patrimonio está en pesos colombianos.';
    } else if(monLabels.length && totalBruto>0){
      const cop = porMoneda['COP']||0;
      const pctExt = Math.round((totalBruto-cop)/totalBruto*100);
      fraseMonEl.textContent = `Tienes el ${pctExt}% de tu patrimonio en moneda extranjera.`;
    } else { fraseMonEl.textContent=''; }
  }

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD PATRIMONIAL — Fase 3: concentración y riesgo
  // ═══════════════════════════════════════════════════════════
  function renderDashboardRiesgo(){
    const data = getMapaData();
    const section = document.getElementById('db-riesgo-section');
    if(!section) return;
    const activos = (data && data.activosNormalizados) ? data.activosNormalizados : [];
    const totalBruto = (data && data.resumen) ? data.resumen.patrimonioBrutoCOP : 0;

    if(!activos.length || totalBruto <= 0){
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const palette=['#0e4d3a','#8a5a14','#1a6b54','#8a1f1c','#2b5f7a','#5a8a73','#b08d2e','#a8a59e'];

    // ── Dependencia del activo más grande ──
    let maxA = activos[0];
    activos.forEach(a => { if(a.valor > maxA.valor) maxA = a; });
    const pctMax = Math.round(maxA.valor / totalBruto * 100);
    document.getElementById('db-dependencia-pct').textContent = pctMax + '%';
    const depFrase = document.getElementById('db-dependencia-frase');
    const depBar = document.getElementById('db-dependencia-bar');
    let depCls;
    if(pctMax >= 50){ depCls='neg'; depFrase.textContent = `Más de la mitad de tu patrimonio depende de un solo activo (${maxA.nombre}). Si algo le pasa, te afecta mucho. Diversificar es clave.`; }
    else if(pctMax >= 30){ depCls='warn'; depFrase.textContent = `Tu activo más grande (${maxA.nombre}) pesa el ${pctMax}% del patrimonio. Es un nivel a vigilar.`; }
    else { depCls='pos'; depFrase.textContent = `Tu patrimonio está bien repartido: ningún activo domina (el mayor es ${maxA.nombre}, ${pctMax}%).`; }
    depFrase.className = 'db-liquidez-frase ' + depCls;
    depBar.style.width = pctMax + '%';
    depBar.className = 'db-bar-fill ' + depCls;

    // ── Dependencia de un solo negocio (solo si hay activos empresariales) ──
    const negCard = document.getElementById('db-negocio-card');
    const neg = (data && data.resumen) ? data.resumen.negocioUnico : null;
    if (negCard) {
      if (neg) {
        negCard.style.display = '';
        const pctNeg = Math.round(neg.mayorPct);
        document.getElementById('db-negocio-pct').textContent = pctNeg + '%';
        const negFrase = document.getElementById('db-negocio-frase');
        const negBar = document.getElementById('db-negocio-bar');
        let negCls;
        if (pctNeg > 40) {
          negCls = 'neg';
          negFrase.textContent = `${neg.mayorNombre} representa el ${pctNeg}% de tu patrimonio, por encima del 40% recomendado. Un negocio puede fallar; concentrar tanto ahí es arriesgado.`;
        } else if (pctNeg >= 25) {
          negCls = 'warn';
          negFrase.textContent = `${neg.mayorNombre} pesa el ${pctNeg}% de tu patrimonio. Está dentro de lo razonable, pero vale la pena vigilarlo.`;
        } else {
          negCls = 'pos';
          negFrase.textContent = `Tu mayor negocio (${neg.mayorNombre}) pesa el ${pctNeg}% del patrimonio. Buen nivel de diversificación.`;
        }
        negFrase.className = 'db-liquidez-frase ' + negCls;
        negBar.style.width = Math.min(pctNeg, 100) + '%';
        negBar.className = 'db-bar-fill ' + negCls;
      } else {
        negCard.style.display = 'none';
      }
    }

    const opts={responsive:true,maintainAspectRatio:true,plugins:{
      legend:{position:'bottom',labels:{font:{family:'Geist',size:11,weight:'500'},boxWidth:10,boxHeight:10,padding:14,color:'#2b2b2e',usePointStyle:true,pointStyle:'circle'}},
      tooltip:{backgroundColor:'#0c0c0d',titleColor:'#fff',bodyColor:'#fff',padding:12,cornerRadius:10,displayColors:false,
        titleFont:{family:'Geist',weight:'600',size:12},bodyFont:{family:'JetBrains Mono',size:12},
        callbacks:{label:ctx=>' '+fmt(ctx.parsed)+' ('+(totalBruto>0?Math.round(ctx.parsed/totalBruto*100):0)+'%)'}}
    }};

    // ── Concentración geográfica ──
    const porPais = {};
    activos.forEach(a => { const p=a._pais||'Colombia'; porPais[p]=(porPais[p]||0)+a.valor; });
    const paisLabels = Object.keys(porPais);
    const paisData = paisLabels.map(k=>porPais[k]);
    if(chartGeo) chartGeo.destroy();
    chartGeo = new Chart(document.getElementById('chart-geografia').getContext('2d'),{
      type:'doughnut',
      data:{labels:paisLabels,datasets:[{data:paisData,backgroundColor:palette,borderWidth:3,borderColor:'#fff',hoverOffset:8}]},
      options:{...opts,cutout:'62%'}
    });
    const fraseGeo = document.getElementById('frase-geografia');
    if(paisLabels.length === 1){
      fraseGeo.textContent = `Todo tu patrimonio está en ${paisLabels[0]}.`;
    } else {
      const colombia = porPais['Colombia']||0;
      const pctExt = Math.round((totalBruto-colombia)/totalBruto*100);
      fraseGeo.textContent = `Tienes el ${pctExt}% de tu patrimonio fuera de Colombia, repartido en ${paisLabels.length-1} ${paisLabels.length-1===1?'país':'países'} más.`;
    }

    // ── Concentración sectorial (solo activos con sector declarado) ──
    const porSector = {};
    let conSector = 0;
    activos.forEach(a => { if(a._sector){ porSector[a._sector]=(porSector[a._sector]||0)+a.valor; conSector+=a.valor; } });
    const secLabels = Object.keys(porSector);
    const fraseSec = document.getElementById('frase-sector');
    if(chartSector) chartSector.destroy();
    if(secLabels.length){
      const secData = secLabels.map(k=>porSector[k]);
      chartSector = new Chart(document.getElementById('chart-sector').getContext('2d'),{
        type:'doughnut',
        data:{labels:secLabels,datasets:[{data:secData,backgroundColor:palette,borderWidth:3,borderColor:'#fff',hoverOffset:8}]},
        options:{...opts,cutout:'62%',plugins:{...opts.plugins,tooltip:{...opts.plugins.tooltip,callbacks:{label:ctx=>' '+fmt(ctx.parsed)+' ('+(conSector>0?Math.round(ctx.parsed/conSector*100):0)+'%)'}}}}
      });
      let maxS=secLabels[0],maxSV=secData[0];
      secData.forEach((v,i)=>{ if(v>maxSV){maxSV=v;maxS=secLabels[i];} });
      const pctS=Math.round(maxSV/conSector*100);
      fraseSec.textContent = `De tus inversiones con sector identificado, el ${pctS}% está en ${maxS}.`;
    } else {
      fraseSec.textContent = 'Aún no has registrado el sector de tus inversiones. Agrégalo en acciones, fondos o empresas para ver tu concentración sectorial.';
    }

    // ── Análisis de deuda ──
    renderAnalisisDeuda(activos);
  }

  function renderAnalisisDeuda(activos){
    const grid = document.getElementById('db-deuda-grid');
    const frase = document.getElementById('frase-deuda');
    if(!grid) return;
    let m2 = {totalDeuda:0,totConsumo:0,totApal:0,totOtro:0};
    try { m2 = calcM2(); } catch(e){}
    // Respaldo: si calcM2 no devuelve deuda (DOM del M2 no montado), usar state.deudas
    let totalDeuda = m2.totalDeuda || 0;
    if(totalDeuda <= 0 && Array.isArray(state.deudas) && state.deudas.length){
      totalDeuda = state.deudas.reduce((s,d)=>s+(d.saldo||0),0);
      m2.totApal = state.deudas.filter(d=>d.grupo==='apalancamiento').reduce((s,d)=>s+(d.saldo||0),0);
      m2.totConsumo = state.deudas.filter(d=>d.grupo==='consumo').reduce((s,d)=>s+(d.saldo||0),0);
    }
    // Cuánta de la deuda está asociada a un activo del mapa
    const deudaEnActivos = activos.reduce((s,a)=>s+(a._deudaCOP||0),0);

    if(totalDeuda <= 0){
      grid.innerHTML = '<div class="db-deuda-item"><span class="db-deuda-label">Sin deudas registradas</span><span class="db-deuda-val">Tu patrimonio está libre de deuda.</span></div>';
      frase.textContent = '';
      return;
    }
    grid.innerHTML = `
      <div class="db-deuda-item"><span class="db-deuda-label">Deuda total</span><span class="db-deuda-val">${fmt(totalDeuda)}</span></div>
      <div class="db-deuda-item"><span class="db-deuda-label">Productiva (apalancamiento)</span><span class="db-deuda-val pos">${fmt(m2.totApal||0)}</span></div>
      <div class="db-deuda-item"><span class="db-deuda-label">De consumo</span><span class="db-deuda-val neg">${fmt(m2.totConsumo||0)}</span></div>`;
    const pctProd = totalDeuda>0 ? Math.round((m2.totApal||0)/totalDeuda*100) : 0;
    if(pctProd >= 70){
      frase.textContent = `El ${pctProd}% de tu deuda es productiva: financia activos que generan valor. Es deuda sana.`;
    } else if(m2.totConsumo > m2.totApal){
      frase.textContent = `La mayor parte de tu deuda es de consumo. Conviene priorizar pagarla, porque no genera retorno.`;
    } else {
      frase.textContent = `El ${pctProd}% de tu deuda financia activos productivos; el resto es consumo u otros.`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD PATRIMONIAL — Fase 4: ingresos pasivos e independencia
  // ═══════════════════════════════════════════════════════════
  function renderDashboardIngresos(){
    const data = getMapaData();
    const section = document.getElementById('db-ingresos-section');
    if(!section) return;
    const activos = (data && data.activosNormalizados) ? data.activosNormalizados : [];
    const r = (data && data.resumen) ? data.resumen : null;
    if(!activos.length || !r){ section.style.display = 'none'; return; }
    section.style.display = '';

    // ── Ingreso pasivo y proyección ──
    const ingresoPasivo = r.ingresoPasivoMensualCOP || 0;
    document.getElementById('db-ingreso-pasivo').textContent = fmt(ingresoPasivo);

    // % de gastos mensuales que cubre el ingreso pasivo
    let gastoMensual = 0;
    try { gastoMensual = (calcM1().totalGas) || 0; } catch(e){ gastoMensual = 0; }
    const cubreEl = document.getElementById('db-ingreso-cubre');
    if (cubreEl) {
      if (gastoMensual > 0) {
        const pctCubre = Math.round(ingresoPasivo / gastoMensual * 100);
        cubreEl.textContent = `Cubre el ${pctCubre}% de tus gastos mensuales`;
      } else {
        cubreEl.textContent = 'De tus activos que generan renta hoy';
      }
    }

    // Renta (ingreso pasivo) proyectada a futuro
    const rentaProy = r.ingresoPasivoProyectado || {a5:0,a10:0,a15:0};
    const renta10 = document.getElementById('db-renta-10');
    const renta15 = document.getElementById('db-renta-15');
    if (renta10) renta10.textContent = fmt(rentaProy.a10);
    if (renta15) renta15.textContent = fmt(rentaProy.a15);

    // Patrimonio proyectado
    const proy = r.patrimonioProyectado || {a5:0,a10:0,a15:0};
    document.getElementById('db-proy-10').textContent = fmt(proy.a10);
    document.getElementById('db-proy-15').textContent = fmt(proy.a15);
    const proyNota = document.getElementById('db-proy-nota');
    const totalAct = activos.length;
    const proyectables = r.activosProyectables || 0;
    if(proyectables < totalAct){
      proyNota.textContent = `Incluye ${proyectables} de ${totalAct} activos (los demás se cuentan a valor de hoy)`;
    } else {
      proyNota.textContent = 'Estimación, no es promesa';
    }

    // ── Independencia financiera ──
    // Medida REAL: qué parte de tus gastos cubre tu ingreso pasivo de verdad (hoy).
    // El potencial teórico (regla del 4% sobre el patrimonio productivo) se muestra aparte.
    const portafolioProd = activos.filter(a => a._esProductivo && !a.restringido).reduce((s,a)=>s+(a._netoCOP||0),0);
    const ifCard = document.getElementById('db-if-card');
    const ringFill = document.getElementById('db-if-ring-fill');
    const pctEl = document.getElementById('db-if-pct');
    const fraseEl = document.getElementById('db-if-frase');
    const detEl = document.getElementById('db-if-detalle');
    const potBox = document.getElementById('db-if-potencial');
    const potText = document.getElementById('db-if-potencial-text');
    const circumf = 2 * Math.PI * 52;

    if(gastoMensual > 0){
      // INDEPENDENCIA REAL = ingreso pasivo que recibes hoy / tus gastos
      const pctReal = (ingresoPasivo / gastoMensual) * 100;
      const pctAnillo = Math.min(pctReal, 100);
      pctEl.textContent = Math.round(pctReal) + '%';
      ringFill.style.strokeDasharray = circumf;
      ringFill.style.strokeDashoffset = circumf * (1 - pctAnillo/100);
      ifCard.classList.remove('if-pos','if-warn','if-neg');
      if(pctReal >= 100){
        ifCard.classList.add('if-pos');
        fraseEl.textContent = '¡Lo lograste! El ingreso que generan tus activos ya cubre tus gastos sin que trabajes.';
      } else if(pctReal >= 50){
        ifCard.classList.add('if-warn');
        fraseEl.textContent = 'Vas por buen camino. Tus activos ya cubren buena parte de tus gastos mensuales.';
      } else {
        ifCard.classList.add('if-neg');
        fraseEl.textContent = 'Estás construyendo tu base. Cada activo que genere renta te acerca a vivir de tus ingresos pasivos.';
      }
      detEl.textContent = `Hoy tus activos te generan ${fmt(ingresoPasivo)} al mes, frente a unos ${fmt(gastoMensual)} de gastos. Cuando ese ingreso cubra el 100%, serás financieramente independiente.`;

      // POTENCIAL teórico: si pusieras tu patrimonio productivo a rentar al 4% anual
      const retiroPotencial = portafolioProd * 0.04 / 12;
      if(portafolioProd > 0 && retiroPotencial > ingresoPasivo * 1.05){
        const pctPot = Math.round((retiroPotencial / gastoMensual) * 100);
        potText.textContent = `Tienes ${fmt(portafolioProd)} en activos que hoy no rentan a su máximo. Si los pusieras a generar renta (al 4% anual), podrías recibir unos ${fmt(retiroPotencial)} al mes (≈${pctPot}% de tus gastos). Tu asesor puede ayudarte a activar ese potencial.`;
        potBox.style.display = 'flex';
      } else {
        potBox.style.display = 'none';
      }
    } else {
      pctEl.textContent = '—';
      ringFill.style.strokeDashoffset = circumf;
      fraseEl.textContent = 'Registra tus gastos mensuales en el Módulo 1 para calcular cuánto cubren tus ingresos pasivos.';
      detEl.textContent = '';
      potBox.style.display = 'none';
    }

    // ── Dependencia de ingresos por activo ──
    renderDependenciaIngresos(activos, ingresoPasivo);
  }

  function renderDependenciaIngresos(activos, ingresoTotal){
    const list = document.getElementById('db-dep-ingreso-list');
    const frase = document.getElementById('frase-dep-ingreso');
    const card = document.getElementById('db-dep-ingreso-card');
    if(!list) return;
    const generadores = activos.filter(a => (a._ingresoMensual||0) > 0)
      .map(a => ({ nombre:a.nombre, ingreso:a._ingresoMensual, moneda:a._moneda }))
      .sort((x,y)=>y.ingreso-x.ingreso);

    if(!generadores.length || ingresoTotal <= 0){
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    // Ingreso en COP de cada generador para el %
    const totalCOP = ingresoTotal;
    list.innerHTML = generadores.map(g => {
      const ingCOP = g.moneda && g.moneda !== 'COP' ? null : g.ingreso; // si extranjero, mostramos sin % exacto
      const pct = (ingCOP != null && totalCOP > 0) ? Math.round(ingCOP/totalCOP*100) : null;
      return `<div class="db-dep-row">
        <div class="db-dep-bar-wrap"><div class="db-dep-bar" style="width:${pct!=null?Math.min(pct,100):50}%"></div></div>
        <div class="db-dep-info"><span class="db-dep-name">${escapeHtml(g.nombre)}</span><span class="db-dep-pct">${pct!=null?pct+'%':fmt(g.ingreso)}</span></div>
      </div>`;
    }).join('');

    const top = generadores[0];
    const topPct = (top.moneda==='COP' && totalCOP>0) ? Math.round(top.ingreso/totalCOP*100) : null;
    if(generadores.length === 1){
      frase.textContent = `Todo tu ingreso pasivo viene de un solo activo (${top.nombre}). Si ese ingreso falla, lo pierdes todo. Conviene diversificar tus fuentes.`;
    } else if(topPct != null && topPct >= 60){
      frase.textContent = `El ${topPct}% de tu ingreso pasivo depende de ${top.nombre}. Es una concentración alta.`;
    } else {
      frase.textContent = `Tu ingreso pasivo viene de ${generadores.length} activos distintos. Buena diversificación de fuentes.`;
    }
  }
  
  /* ═══════════════════════════════════════════════════════════
     SIMULADOR DE DEUDA (Módulo 7)
     ═══════════════════════════════════════════════════════════ */
  let chartDebtSim = null;

  /* Tasa Efectiva Anual (decimal) → tasa efectiva mensual (decimal) */
  function eaToMonthly(ea){
    if(!ea || ea <= 0) return 0;
    return Math.pow(1 + ea, 1/12) - 1;
  }
  /* Cuota fija de un crédito amortizado */
  function cuotaAmortizada(P, im, n){
    if(n <= 0) return P;
    if(im <= 0) return P / n;
    return P * im / (1 - Math.pow(1 + im, -n));
  }
  function mesesATexto(m){
    if(m == null) return '—';
    const a = Math.floor(m / 12), me = m % 12;
    if(a === 0) return m + (m === 1 ? ' mes' : ' meses');
    if(me === 0) return a + (a === 1 ? ' año' : ' años');
    return a + (a === 1 ? ' año' : ' años') + ' y ' + me + (me === 1 ? ' mes' : ' meses');
  }
  function fechaLibertad(meses){
    const d = new Date();
    d.setMonth(d.getMonth() + meses);
    return MES_NAMES_ES[d.getMonth()] + ' ' + d.getFullYear();
  }
  function stratLabel(s){
    return s === 'bola_nieve' ? 'Bola de nieve' : s === 'personalizada' ? 'Orden personalizado' : 'Avalancha';
  }
  /* Etiqueta completa del plan: método + sufijo de compra de cartera si está activa */
  function planLabel(){
    const ds = state.debtSim || {};
    return stratLabel(ds.estrategia) + (ds.consolidacionActiva ? ' · con compra de cartera' : '');
  }
  /* ¿La cuota de esta deuda apenas cubre los intereses? (no amortiza) */
  function esSoloIntereses(d){
    return d.saldo > 0.5 && d.pago > 0 && d.pago <= d.saldo * d.em * 1.001;
  }
  function ordenarEstrategia(lista, estrategia){
    const arr = [...lista];
    if(estrategia === 'personalizada'){
      // Orden manual por id; respeta exactamente lo que el usuario arrastró.
      const ord = (state.debtSim && state.debtSim.ordenPersonalizado) || [];
      if(ord.length){
        arr.sort((a,b)=>{
          let ia = ord.indexOf(a.id), ib = ord.indexOf(b.id);
          if(ia === -1) ia = 1e6 + (a.orden ?? 0);
          if(ib === -1) ib = 1e6 + (b.orden ?? 0);
          return ia - ib;
        });
      } else {
        arr.sort((a,b)=> (a.orden ?? 0) - (b.orden ?? 0));
      }
      return arr;
    }
    // avalancha / bola de nieve: el orden base del método…
    const cmp = estrategia === 'bola_nieve'
      ? (a,b)=> a.saldo - b.saldo
      : (a,b)=> (b.em - a.em) || (a.saldo - b.saldo); // avalancha
    // …pero las deudas que solo pagan intereses (no amortizan) van primero: son el hueco negro.
    arr.sort((a,b)=>{
      const sa = esSoloIntereses(a) ? 0 : 1, sb = esSoloIntereses(b) ? 0 : 1;
      if(sa !== sb) return sa - sb;
      return cmp(a,b);
    });
    return arr;
  }

  /* Motor de amortización mes a mes.
     deudas: [{nombre, saldo, em(mensual), pago}]
     opts.rollover: si true, redistribuye los mínimos liberados + capacidad extra (estrategia).
                    si false, cada deuda paga solo su mínimo (escenario "solo mínimos"). */
  function simularDeuda(deudas, capacidadExtra, estrategia, abonos, opts){
    const MAX = 600;
    const lista = deudas.filter(d => d.saldo > 0.5)
      .map((d,idx) => ({id:d.id, nombre:d.nombre, saldo:d.saldo, em:d.em, pago:d.pago, payoffMes:null, orden: (d.orden != null ? d.orden : idx)}));
    const baseMin = lista.reduce((s,d)=> s + d.pago, 0);
    const budget = baseMin + (opts.useExtra ? capacidadExtra : 0);
    let mes = 0, totalInteres = 0, totalPagado = 0, estancado = false;
    const serie = [ lista.reduce((s,d)=> s + d.saldo, 0) ];
    const interesSerie = [ 0 ];

    while(lista.some(d => d.saldo > 0.5)){
      mes++;
      if(mes > MAX){ estancado = true; break; }
      // Causación de intereses
      lista.forEach(d => { if(d.saldo > 0.5){ const it = d.saldo * d.em; d.saldo += it; totalInteres += it; } });

      if(!opts.rollover){
        // Cada deuda paga solo su propio mínimo
        lista.forEach(d => {
          if(d.saldo > 0.5){
            const p = Math.min(d.pago, d.saldo);
            d.saldo -= p; totalPagado += p;
            if(d.saldo <= 0.5 && d.payoffMes == null) d.payoffMes = mes;
          }
        });
      } else {
        let pool = budget;
        // 1) Pagar mínimos de las deudas activas
        lista.forEach(d => {
          if(d.saldo > 0.5){
            const p = Math.min(d.pago, d.saldo, pool);
            d.saldo -= p; pool -= p; totalPagado += p;
          }
        });
        // 2) Excedente (mínimos liberados + capacidad extra) + abono extraordinario del mes
        let extra = pool + (abonos[mes] || 0);
        // 3) Atacar en el orden de la estrategia
        const orden = ordenarEstrategia(lista.filter(d => d.saldo > 0.5), estrategia);
        for(const d of orden){
          if(extra <= 0) break;
          const p = Math.min(extra, d.saldo);
          d.saldo -= p; extra -= p; totalPagado += p;
        }
        lista.forEach(d => { if(d.saldo <= 0.5 && d.payoffMes == null) d.payoffMes = mes; });
      }
      lista.forEach(d => { if(d.saldo < 0) d.saldo = 0; });
      serie.push(lista.reduce((s,d)=> s + Math.max(0, d.saldo), 0));
      interesSerie.push(totalInteres);
    }
    return {mes, totalInteres, totalPagado, serie, interesSerie, deudas:lista, estancado, budget, baseMin};
  }

  /* Reemplaza las deudas marcadas para unificar por un único crédito consolidado */
  function aplicarConsolidacion(base, tasaEA, plazo){
    const aUnir = base.filter(d => d.consolidar && d.saldo > 0.5);
    const resto = base.filter(d => !(d.consolidar && d.saldo > 0.5)).map(d => ({...d}));
    if(aUnir.length < 1){
      return {lista: base.map(d => ({...d})), info: null};
    }
    const P = aUnir.reduce((s,d)=> s + d.saldo, 0);
    const em = eaToMonthly(tasaEA);
    const pago = cuotaAmortizada(P, em, plazo);
    const consolidada = {id:'__cons__', nombre:'Crédito consolidado (compra de cartera)', saldo:P, em, pago, consolidar:false, tasa:tasaEA, orden:-1};
    return {lista: [consolidada, ...resto], info: {P, pago, em, count: aUnir.length, plazo, tasaEA}};
  }

  function genDebtId(){ return 'sd_' + Date.now().toString(36) + Math.floor(Math.random()*1e9).toString(36); }
  function seedDebtSimFromM2(){
    state.debtSim.deudas = (state.deudas || [])
      .filter(d => (d.saldo || 0) > 0)
      .map(d => ({
        id: genDebtId(),
        nombre: d.nombre || 'Deuda',
        saldo: d.saldo || 0,
        tasa: d.tasa_anual || 0,
        pago: d.cuota_mensual || 0,
        consolidar: false
      }));
    state.debtSim.seeded = true;
  }

  function renderDebtSim(){
    const ds = state.debtSim;
    if(!ds.customized || !ds.deudas.length) seedDebtSimFromM2();

    const cap = document.getElementById('ds-capacidad');
    cap.value = ds.capacidadExtra ? fmtInput(ds.capacidadExtra) : '';
    if(!cap.dataset.money) attachMoneyInput(cap);
    if(!cap.dataset.wired){ cap.dataset.wired='1'; cap.addEventListener('input', recalcDebtSim); cap.addEventListener('change', recalcDebtSim); }
    const useSup = document.getElementById('ds-use-superavit');
    if(useSup && !useSup.dataset.wired){
      useSup.dataset.wired='1';
      useSup.addEventListener('click', function(){
        const sup = Math.max(0, Math.round(superavitMensual()));
        state.debtSim.capacidadExtra = sup;
        const capIn = document.getElementById('ds-capacidad');
        if(capIn) capIn.value = sup ? fmtInput(sup) : '';
        recalcDebtSim();
      });
    }
    document.getElementById('ds-cons-tasa').value = ds.consolidacionTasa;
    document.getElementById('ds-cons-plazo').value = ds.consolidacionPlazo;
    const consToggle = document.getElementById('ds-cons-toggle');
    if(consToggle) consToggle.checked = !!ds.consolidacionActiva;
    const ab = document.getElementById('ds-abono-monto');
    ab.value = ds.abonoMonto ? fmtInput(ds.abonoMonto) : '';
    if(!ab.dataset.money) attachMoneyInput(ab);
    if(!ab.dataset.wired){ ab.dataset.wired='1'; ab.addEventListener('input', recalcDebtSim); ab.addEventListener('change', recalcDebtSim); }
    document.getElementById('ds-abono-mes').value = ds.abonoMes;
    const fuenteSel = document.getElementById('ds-abono-fuente');
    if(fuenteSel){
      fuenteSel.value = ds.abonoFuente || 'ingreso';
      if(!fuenteSel.dataset.wired){ fuenteSel.dataset.wired='1'; fuenteSel.addEventListener('change', recalcDebtSim); }
    }

    document.querySelectorAll('#ds-strat .ds-strat-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.strat === ds.estrategia));
    document.getElementById('ds-cons-config').style.display = ds.consolidacionActiva ? 'block' : 'none';
    document.getElementById('modulo-7').classList.toggle('ds-cons-mode', !!ds.consolidacionActiva);
    document.getElementById('modulo-7').classList.toggle('ds-personal-mode', ds.estrategia === 'personalizada');

    renderDebtSimRows();
    renderDebtSimResults();
  }

  function renderDebtSimRows(){
    const body = document.getElementById('ds-deudas-body');
    const ds = state.debtSim;
    body.innerHTML = '';
    document.getElementById('ds-deudas-count').textContent =
      ds.deudas.length + (ds.deudas.length === 1 ? ' deuda' : ' deudas');
    if(!ds.deudas.length){
      body.innerHTML = '<div class="ds-empty">No hay deudas para simular. Agrega una o recárgalas desde tu módulo de endeudamiento.</div>';
      return;
    }
    ds.deudas.forEach((d,i) => {
      if(!d.id) d.id = genDebtId();
      const row = document.createElement('div');
      row.className = 'ds-deuda-row';
      row.dataset.i = i;
      const tasaVal = (d.tasa * 100) ? (d.tasa * 100).toFixed(1) : '';
      row.innerHTML =
        '<div class="ds-dr-head">'
        + '<input type="text" class="it-name" data-f="nombre" value="' + String(d.nombre || '').replace(/"/g,'&quot;') + '" placeholder="Nombre de la deuda">'
        + '<button class="it-del" title="Quitar">' + SVG_X + '</button>'
        + '</div>'
        + '<div class="ds-dr-grid">'
        + '<div class="mr-field"><label>Saldo actual</label><input class="money-input" data-f="saldo" placeholder="0"></div>'
        + '<div class="mr-field"><label>Tasa anual % (E.A.)</label><input type="number" data-f="tasa" min="0" max="200" step="0.1" value="' + tasaVal + '" placeholder="0"></div>'
        + '<div class="mr-field"><label>Cuota / pago mínimo</label><input class="money-input" data-f="pago" placeholder="0"></div>'
        + (ds.consolidacionActiva ? '<label class="ds-cons-check"><input type="checkbox" data-f="consolidar" ' + (d.consolidar ? 'checked' : '') + '><span>Unificar</span></label>' : '')
        + '</div>'
        + '<div class="ds-dr-flag" data-flag></div>';
      body.appendChild(row);
      const sIn = row.querySelector('input[data-f=saldo]');
      sIn.value = d.saldo > 0 ? fmtInput(d.saldo) : ''; attachMoneyInput(sIn);
      const pIn = row.querySelector('input[data-f=pago]');
      pIn.value = d.pago > 0 ? fmtInput(d.pago) : ''; attachMoneyInput(pIn);
      row.querySelectorAll('input').forEach(el => { const h = () => { state.debtSim.customized = true; recalcDebtSim(); }; el.addEventListener('input', h); if(el.type==='checkbox') el.addEventListener('change', h); });
      row.querySelector('.it-del').addEventListener('click', () => {
        state.debtSim.customized = true;
        state.debtSim.deudas.splice(i, 1);
        renderDebtSimRows();
        recalcDebtSim();
      });
    });
  }

  const SVG_DRAG_HANDLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';

  /* Reordenamiento por arrastre (pointer events · escritorio y móvil)
     Opera sobre la lista de "Orden de ataque" cuando la estrategia es personalizada. */
  function updateDragPrios(container){
    const c = container || document.getElementById('ds-order-list');
    if(!c) return;
    Array.from(c.querySelectorAll('.ds-drag-row')).forEach((r,idx) => {
      const num = r.querySelector('.ds-order-num'); if(num) num.textContent = idx + 1;
    });
  }
  function wireDebtDragHandle(handle, row){
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      if(state.debtSim.estrategia !== 'personalizada') return;
      e.preventDefault();
      const container = row.parentElement;
      row.classList.add('ds-dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      function move(ev){
        const sibs = Array.from(container.querySelectorAll('.ds-drag-row:not(.ds-dragging)'));
        let placed = false;
        for(const sib of sibs){
          const r = sib.getBoundingClientRect();
          if(ev.clientY < r.top + r.height / 2){ container.insertBefore(row, sib); placed = true; break; }
        }
        if(!placed) container.appendChild(row);
        updateDragPrios(container);
      }
      function end(){
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        row.classList.remove('ds-dragging');
        state.debtSim.customized = true;
        // Guardar el orden personalizado por id (incluye el crédito consolidado si está activo)
        state.debtSim.ordenPersonalizado = Array.from(container.querySelectorAll('.ds-drag-row'))
          .map(r => r.dataset.id).filter(Boolean);
        renderDebtSimResults();   // recalcula y reconstruye la lista en el nuevo orden
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
  }

  function recalcDebtSim(){
    const ds = state.debtSim;
    const capEl = document.getElementById('ds-capacidad'); if(!capEl) return;
    ds.capacidadExtra   = n(capEl.value);
    // Si el plan está incluido en los presupuestos, mantener la foto al día
    if(state.tablero.planDeuda && state.tablero.planDeuda.activo){
      state.tablero.planDeuda.extraMensual = ds.capacidadExtra || 0;
      scheduleSave('tablero');
    }
    ds.consolidacionTasa  = parseFloat(document.getElementById('ds-cons-tasa').value) || 0;
    ds.consolidacionPlazo = parseInt(document.getElementById('ds-cons-plazo').value) || 36;
    ds.abonoMonto = n(document.getElementById('ds-abono-monto').value);
    ds.abonoMes   = Math.max(1, parseInt(document.getElementById('ds-abono-mes').value) || 1);
    const fuenteEl = document.getElementById('ds-abono-fuente');
    if(fuenteEl) ds.abonoFuente = fuenteEl.value || 'ingreso';
    // Si el plan está incluido en los presupuestos, mantener la foto del abono al día
    if(state.tablero.planDeuda && state.tablero.planDeuda.activo){
      state.tablero.planDeuda.abono = {monto: ds.abonoMonto||0, mes: ds.abonoMes||1, fuente: ds.abonoFuente||'ingreso'};
      scheduleSave('tablero');
    }
    document.querySelectorAll('#ds-deudas-body .ds-deuda-row').forEach(row => {
      const i = +row.dataset.i; const d = ds.deudas[i]; if(!d) return;
      d.nombre = row.querySelector('input[data-f=nombre]').value;
      d.saldo  = n(row.querySelector('input[data-f=saldo]').value);
      d.tasa   = (parseFloat(row.querySelector('input[data-f=tasa]').value) || 0) / 100;
      d.pago   = n(row.querySelector('input[data-f=pago]').value);
      const cb = row.querySelector('input[data-f=consolidar]'); if(cb) d.consolidar = cb.checked;
    });
    renderDebtSimResults();
    // El simulador NO se autoguarda: es un borrador. Solo persiste al pulsar "Agregar a mi plan de acción".
  }

  function renderDebtSimResults(){
    const ds = state.debtSim;
    const cont = document.getElementById('ds-resultados');

    // Banderas por deuda (interés-solo / tasa alta)
    document.querySelectorAll('#ds-deudas-body .ds-deuda-row').forEach(row => {
      const i = +row.dataset.i; const d = ds.deudas[i]; const flag = row.querySelector('[data-flag]');
      if(!d || !flag) return;
      const em = eaToMonthly(d.tasa); const interesMes = d.saldo * em;
      if(d.saldo > 0 && d.pago > 0 && d.pago <= interesMes * 1.001){
        flag.style.display = 'flex'; flag.className = 'ds-dr-flag warn';
        flag.innerHTML = SVG_WARN + '<span>Con esta cuota apenas cubres los intereses (' + fmt(interesMes) + '/mes): el saldo casi no baja. Con pagos mínimos esta deuda no se acaba — priorízala o abónale extra.</span>';
      } else if(d.saldo > 0 && d.tasa >= 0.25){
        flag.style.display = 'flex'; flag.className = 'ds-dr-flag hot';
        flag.innerHTML = SVG_WARN + '<span>Tasa alta (' + pct(d.tasa) + ' E.A.). Es de las más costosas: buena candidata para atacar primero o refinanciar.</span>';
      } else { flag.style.display = 'none'; flag.innerHTML = ''; }
    });

    const base = ds.deudas.filter(d => d.saldo > 0.5).map((d,idx) => ({
      id: d.id, nombre: d.nombre || 'Deuda', saldo: d.saldo, em: eaToMonthly(d.tasa),
      pago: d.pago, consolidar: d.consolidar, tasa: d.tasa, orden: idx
    }));
    const baseMin = base.reduce((s,d)=> s + d.pago, 0);
    document.getElementById('ds-base-min').textContent = fmt(baseMin);
    document.getElementById('ds-budget').textContent = fmt(baseMin + ds.capacidadExtra);
    // Ancla al superávit real + aviso (solo informa, no bloquea)
    const sup = superavitMensual();
    const supEl = document.getElementById('ds-superavit');
    if(supEl) supEl.textContent = fmt(sup);
    const warnEl = document.getElementById('ds-cap-warn');
    if(warnEl){
      const exceso = (ds.capacidadExtra||0) - sup;
      if(exceso > 0.5){
        warnEl.style.display = 'flex';
        warnEl.innerHTML = SVG_WARN + '<span>Estás abonando <strong>' + fmt(exceso) + ' más</strong> de lo que te queda libre cada mes. El plan podría no ser sostenible: para lograrlo tendrías que <strong>ajustar tus gastos</strong> y liberar ese margen.</span>';
      } else {
        warnEl.style.display = 'none';
        warnEl.innerHTML = '';
      }
    }

    if(!base.length){
      cont.innerHTML = '<div class="card"><div class="ds-empty">Agrega al menos una deuda con saldo para ver tu plan.</div></div>';
      if(chartDebtSim){ chartDebtSim.destroy(); chartDebtSim = null; }
      return;
    }

    const abonos = {};
    if(ds.abonoMonto > 0) abonos[Math.max(1, ds.abonoMes)] = ds.abonoMonto;

    // Capa de compra de cartera (independiente del orden), y luego el orden elegido
    let processed, ordering, consInfo = null;
    if(ds.consolidacionActiva){
      const r = aplicarConsolidacion(base, ds.consolidacionTasa / 100, ds.consolidacionPlazo);
      processed = r.lista; consInfo = r.info;
    } else {
      processed = base.map(d => ({...d}));
    }
    ordering = ds.estrategia;

    const plan    = simularDeuda(processed.map(d=>({...d})), ds.capacidadExtra, ordering, abonos, {rollover:true,  useExtra:true});
    const minimos = simularDeuda(base.map(d=>({...d})), 0, 'avalancha', {}, {rollover:false, useExtra:false});
    const planAval  = simularDeuda(processed.map(d=>({...d})), ds.capacidadExtra, 'avalancha',  abonos, {rollover:true, useExtra:true});
    const planNieve = simularDeuda(processed.map(d=>({...d})), ds.capacidadExtra, 'bola_nieve', abonos, {rollover:true, useExtra:true});
    // Mismo orden, pero SIN consolidar — para medir el efecto puro de la compra de cartera
    const planSinCons = simularDeuda(base.map(d=>({...d})), ds.capacidadExtra, ordering, abonos, {rollover:true, useExtra:true});

    // Nombre(s) de la(s) deuda(s) que con solo mínimos NUNCA terminan (no amortizan)
    const minimosNuncaTermina = (minimos.deudas || []).filter(d => d.payoffMes == null && d.saldo > 0.5);
    const nombreNuncaTermina = minimosNuncaTermina.map(d => d.nombre || 'Deuda').join(', ');
    // Cantidad de deudas que SÍ se amortizan con solo mínimos (a estas NO les traemos nombre)
    const nAmortizan = (minimos.deudas || []).filter(d => d.payoffMes != null).length;
    const refOtras = nAmortizan > 0
      ? (nAmortizan === 1 ? 'tu otra deuda' : 'tus ' + nAmortizan + ' demás deudas')
      : '';

    let ahorroVal, ahorroSub, ahorroPos = false;
    if(plan.estancado){
      ahorroVal = '—'; ahorroSub = 'Aumenta tu abono para ver el ahorro';
    } else if(!minimos.estancado){
      const a = Math.max(0, minimos.totalInteres - plan.totalInteres);
      const m = minimos.mes - plan.mes;
      ahorroVal = fmt(a); ahorroPos = a > 0;
      ahorroSub = (m > 0) ? ('Y quedas libre ' + m + ' meses antes') : 'En intereses';
    } else {
      // Con solo mínimos alguna deuda nunca termina: comparamos en el horizonte de tu plan
      const idx = Math.min(plan.mes, (minimos.interesSerie || []).length - 1);
      const intMin = (minimos.interesSerie && minimos.interesSerie[idx]) || 0;
      const a = Math.max(0, intMin - plan.totalInteres);
      ahorroVal = fmt(a); ahorroPos = a > 0;
      ahorroSub = nombreNuncaTermina
        ? ('Con solo mínimos, ' + nombreNuncaTermina + ' nunca termina' + (refOtras ? ' (y sigues pagando ' + refOtras + ')' : '') + '; tú sales en ' + mesesATexto(plan.mes))
        : ('Con solo mínimos esa deuda nunca termina; tú sales en ' + mesesATexto(plan.mes));
    }
    // Si no hay abono extra pero igual hay ahorro, viene del método (ordenar y redirigir cuotas)
    if(ahorroPos && (ds.capacidadExtra || 0) <= 0){
      ahorroSub = 'Solo por ordenar y redirigir tus cuotas, sin poner un peso extra';
    }

    /* ── KPIs ── */
    let html = '<div class="kpi-grid">'
      + '<div class="kpi ' + (plan.estancado ? 'is-neg' : 'is-pos') + ' span-2">'
      + '<div class="kpi-label">Quedas libre de deudas en</div>'
      + '<div class="kpi-value">' + (plan.estancado ? 'No se liquida' : mesesATexto(plan.mes)) + '</div>'
      + '<div class="kpi-sub">' + (plan.estancado ? 'Aumenta tu abono extra o considera consolidar' : 'Fecha estimada · ' + fechaLibertad(plan.mes)) + '</div>'
      + '</div>'
      + '<div class="kpi">'
      + '<div class="kpi-label">Intereses que pagarás</div>'
      + '<div class="kpi-value">' + (plan.estancado ? '—' : fmt(plan.totalInteres)) + '</div>'
      + '<div class="kpi-sub">Con tu plan actual</div>'
      + '</div>'
      + '<div class="kpi ' + (ahorroPos ? 'is-pos' : '') + '">'
      + '<div class="kpi-label">Te ahorras vs. solo mínimos</div>'
      + '<div class="kpi-value">' + ahorroVal + '</div>'
      + '<div class="kpi-sub">' + ahorroSub + '</div>'
      + '</div>'
      + '</div>';

    // Fila "Solo pagos mínimos": nombramos SOLO la deuda que nunca termina; a las demás
    // (si las hay) las referimos genéricamente. Los intereses son el TOTAL de todas las
    // deudas acumulado hasta el horizonte de TU plan (comparación justa).
    let minTiempoTxt, minInteresTxt;
    if(minimos.estancado){
      const idxH = Math.min(plan.mes, (minimos.interesSerie || []).length - 1);
      const intMinHorizonte = (minimos.interesSerie && minimos.interesSerie[idxH]) || 0;
      if(nombreNuncaTermina){
        minTiempoTxt = 'No termina · ' + nombreNuncaTermina
          + (refOtras ? ' <span class="ds-cmp-note">(+ ' + refOtras + ')</span>' : '');
      } else {
        minTiempoTxt = 'No termina';
      }
      minInteresTxt = (plan.estancado || intMinHorizonte <= 0)
        ? '—'
        : (fmt(intMinHorizonte) + ' <span class="ds-cmp-note">' + (refOtras ? 'total de tus deudas, en el mismo plazo de tu plan' : 'en el mismo plazo de tu plan') + '</span>');
    } else {
      minTiempoTxt = mesesATexto(minimos.mes);
      minInteresTxt = fmt(minimos.totalInteres);
    }
    /* ── Comparación ── */
    html += '<div class="card">'
      + '<div class="card-head"><div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v18M3 7h18M5 7l3 7H2zM19 7l3 7h-6z"/></svg></div><h3>Tu plan vs. pagar solo mínimos</h3></div>'
      + '<div class="ds-cmp">'
      + '<div class="ds-cmp-row head"><span>Escenario</span><span>Tiempo</span><span>Intereses</span></div>'
      + '<div class="ds-cmp-row"><span>Solo pagos mínimos</span><span>' + minTiempoTxt + '</span><span>' + minInteresTxt + '</span></div>'
      + '<div class="ds-cmp-row best"><span>Tu plan · ' + planLabel() + '</span><span>' + (plan.estancado ? 'No termina' : mesesATexto(plan.mes)) + '</span><span>' + (plan.estancado ? '—' : fmt(plan.totalInteres)) + '</span></div>'
      + '</div></div>';

    /* ── Orden de ataque (refleja el método; arrastrable si es personalizado) ── */
    const esPersonal = ds.estrategia === 'personalizada';
    // Fecha de liberación por id de deuda (robusto ante nombres repetidos)
    const payoffById = {};
    plan.deudas.forEach(d => { payoffById[d.id] = d.payoffMes; });
    // La lista de ataque sale SIEMPRE de la lista procesada (incluye el crédito consolidado si aplica)
    const attackList = ordenarEstrategia(processed, ordering)
      .filter(d => d.saldo > 0.5)
      .map(d => ({id:d.id, nombre:d.nombre, saldo:d.saldo, payoffMes:payoffById[d.id]}));
    html += '<div class="card" id="ds-order-card">'
      + '<div class="card-head"><div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></div><h3>'
      + (esPersonal ? 'Tu orden de ataque · arrástralas' : 'Orden de ataque · ' + planLabel())
      + '</h3></div>'
      + '<p class="ds-hint">'
      + (esPersonal
          ? 'Arrastra cada deuda por el asa para decidir cuál atacar primero (la de arriba recibe el abono extra). El plan se recalcula al soltar.'
          : 'Este es el orden que estableció el método: a cuál diriges primero el abono extra. Las deudas que solo pagan intereses van primero. La fecha es cuándo queda saldada cada una.')
      + '</p>'
      + '<div class="ds-order" id="ds-order-list">';
    attackList.forEach((d,idx) => {
      const liber = d.payoffMes != null
        ? ('Libre en ' + mesesATexto(d.payoffMes) + ' · ' + fechaLibertad(d.payoffMes))
        : 'No se liquida en el horizonte simulado';
      html += '<div class="ds-order-item ds-drag-row' + (d.payoffMes==null?' pend':'') + '" data-id="' + d.id + '">'
        + (esPersonal ? '<button class="ds-drag-handle" title="Arrastra para reordenar">' + SVG_DRAG_HANDLE + '</button>' : '')
        + '<div class="ds-order-num">' + (d.payoffMes==null && !esPersonal ? '!' : (idx + 1)) + '</div>'
        + '<div class="ds-order-body"><div class="ds-order-name">' + (d.nombre || 'Deuda') + '</div>'
        + '<div class="ds-order-meta">' + liber + '</div></div>'
        + '</div>';
    });
    html += '</div></div>';

    /* ── Recomendaciones ── */
    const tips = [];
    if(ds.estrategia === 'personalizada' && !plan.estancado && !planAval.estancado){
      const sobrecosto = plan.totalInteres - planAval.totalInteres;
      if(sobrecosto > 1000){
        tips.push('Tu <strong>orden personalizado</strong> te cuesta ' + fmt(sobrecosto) + ' más en intereses que la avalancha pura. Vale la pena si tienes una razón concreta (liberar a un codeudor, saldar una deuda familiar antes), pero tenlo presente.');
      } else {
        tips.push('Tu <strong>orden personalizado</strong> queda muy cerca del óptimo matemático: prácticamente no pagas intereses de más por seguir tu propia prioridad. Buena elección.');
      }
    }
    if(ds.estrategia !== 'personalizada' && !planAval.estancado && !planNieve.estancado){
      const dif = planNieve.totalInteres - planAval.totalInteres;
      const firstAval = planAval.deudas.filter(d=>d.payoffMes!=null).sort((a,b)=>a.payoffMes-b.payoffMes)[0];
      const firstNieve = planNieve.deudas.filter(d=>d.payoffMes!=null).sort((a,b)=>a.payoffMes-b.payoffMes)[0];
      if(dif > 1000){
        tips.push('La <strong>avalancha</strong> te ahorra ' + fmt(dif) + ' en intereses frente a la bola de nieve. Pero la <strong>bola de nieve</strong> libera tu primera deuda'
          + (firstNieve ? ' (' + firstNieve.nombre + ') en ' + mesesATexto(firstNieve.payoffMes) : '') + ', útil si necesitas motivación temprana.');
      } else {
        tips.push('En tu caso la avalancha y la bola de nieve dan un resultado casi idéntico en intereses. Elige la bola de nieve si te ayuda a mantener la disciplina.');
      }
    }
    if(consInfo){
      const dif = planSinCons.totalInteres - plan.totalInteres; // ahorro de consolidar, con el MISMO orden
      const mesDif = planSinCons.mes - plan.mes;
      if(!plan.estancado && !planSinCons.estancado && dif > 1000){
        tips.push('<strong>Consolidar te conviene:</strong> unificando ' + consInfo.count + ' deuda(s) pagas ' + fmt(dif) + ' menos en intereses'
          + (mesDif > 0 ? ' y quedas libre ' + mesDif + ' meses antes' : '')
          + '; la cuota del crédito unificado sería ' + fmt(consInfo.pago) + '/mes a ' + consInfo.plazo + ' meses.');
      } else {
        tips.push('<strong>Ojo con esta consolidación:</strong> con la tasa (' + (consInfo.tasaEA*100).toFixed(1) + '% E.A.) y plazo (' + consInfo.plazo + ' meses) indicados, no mejora tu situación frente a no consolidar y atacar en el mismo orden. Negocia una tasa más baja o acorta el plazo.');
      }
    }
    const interesSolo = processed.filter(d => esSoloIntereses({saldo:d.saldo, pago:d.pago, em:d.em}));
    if(interesSolo.length){
      const nombres = interesSolo.map(d=>d.nombre||'sin nombre').join(', ');
      tips.push('Tienes ' + interesSolo.length + ' deuda(s) donde la cuota <strong>solo cubre intereses</strong> (' + nombres + '): con esa cuota nunca se acaban. '
        + (ds.estrategia === 'personalizada'
            ? 'Te recomiendo arrastrarla(s) al inicio de tu orden de ataque.'
            : 'Por eso el orden de ataque las pone <strong>de primeras</strong>.'));
    }
    if(ds.capacidadExtra === 0 && !plan.estancado){
      const sugerido = Math.max(200000, Math.round(baseMin * 0.1 / 50000) * 50000);
      const conExtra = simularDeuda(base.map(d=>({...d})), sugerido, ordering === 'avalancha' ? 'avalancha' : ordering, abonos, {rollover:true, useExtra:true});
      if(!conExtra.estancado && conExtra.mes < plan.mes){
        tips.push('Hoy solo cubres mínimos. Si abonaras apenas ' + fmt(sugerido) + ' extra al mes, quedarías libre <strong>' + (plan.mes - conExtra.mes) + ' meses antes</strong> y pagarías ' + fmt(plan.totalInteres - conExtra.totalInteres) + ' menos en intereses.');
      }
    }
    if(tips.length){
      html += '<div class="card">'
        + '<div class="card-head"><div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg></div><h3>Recomendaciones</h3></div>'
        + '<div class="ds-advice">';
      tips.forEach(t => { html += '<div class="ds-advice-item">' + SVG_CHECK + '<span>' + t + '</span></div>'; });
      html += '</div></div>';
    }

    html += '<div class="card"><div class="ds-plan-actions" style="display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap">'
      + '<div style="font-size:13.5px;color:rgba(0,0,0,.62)">¿Te convence este plan? Guárdalo en tu plan de acción.</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      + '<button class="btn-ghost" id="ds-toggle-tablero" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + (ds.ocultarPlanTablero
          ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mostrar en el tablero'
          : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>Quitar del tablero')
      + '</button>'
      + '<button class="btn btn-primary" id="ds-add-plan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>Agregar a mi plan de acción</button>'
      + '</div>'
      + '</div>'
      + '<label class="ds-budget-toggle"><input type="checkbox" id="ds-include-budget"' + ((state.tablero.planDeuda && state.tablero.planDeuda.activo) ? ' checked' : '') + '>'
      + '<span><strong>Incluir este plan en mis presupuestos.</strong> Tu abono extra mensual (' + fmt(ds.capacidadExtra||0) + ') entra al presupuesto mensual del tablero, y tu abono extraordinario' + (ds.abonoMonto>0 ? ' (' + fmt(ds.abonoMonto) + ')' : '') + ' al módulo de gastos no periódicos. Es reversible: desmárcalo y se quita.</span></label>'
      + '</div>';

    cont.innerHTML = html;
    if(ds.estrategia === 'personalizada'){
      document.querySelectorAll('#ds-order-list .ds-drag-row').forEach(row => {
        wireDebtDragHandle(row.querySelector('.ds-drag-handle'), row);
      });
    }
    const addPlanBtn = document.getElementById('ds-add-plan');
    if(addPlanBtn) addPlanBtn.addEventListener('click', copiarPlanSimulador);
    const togTab = document.getElementById('ds-toggle-tablero');
    if(togTab) togTab.addEventListener('click', function(){
      state.debtSim.ocultarPlanTablero = !state.debtSim.ocultarPlanTablero;
      if(typeof persistModule === 'function') persistModule('simulador_deuda');
      renderDebtSimResults();  // re-render para actualizar la etiqueta del botón
      showToast(state.debtSim.ocultarPlanTablero ? 'Plan quitado del tablero de control' : 'Plan visible en el tablero de control', 'success');
    });
    const incBudget = document.getElementById('ds-include-budget');
    if(incBudget) incBudget.addEventListener('change', function(){
      if(!state.tablero.planDeuda) state.tablero.planDeuda = {activo:false, extraMensual:0, abono:{monto:0,mes:1,fuente:'ingreso'}};
      state.tablero.planDeuda.activo = this.checked;
      state.tablero.planDeuda.extraMensual = this.checked ? (state.debtSim.capacidadExtra||0) : 0;
      state.tablero.planDeuda.abono = this.checked
        ? {monto: state.debtSim.abonoMonto||0, mes: state.debtSim.abonoMes||1, fuente: state.debtSim.abonoFuente||'ingreso'}
        : {monto:0, mes:1, fuente:'ingreso'};
      scheduleSave('tablero');
      showToast(this.checked ? 'Plan incluido en tus presupuestos (mensual y anual)' : 'Plan quitado de tus presupuestos', 'success');
    });
    renderDebtSimChart(plan, minimos);
  }

  function renderDebtSimChart(plan, minimos){
    const canvas = document.getElementById('ds-chart');
    if(!canvas) return;
    const N = Math.min(Math.max(plan.estancado ? 120 : plan.mes, 1), 120);
    const labels = [];
    for(let i = 0; i <= N; i++) labels.push(i % 6 === 0 ? ('Mes ' + i) : '');
    const planSerie = plan.serie.slice(0, N + 1);
    while(planSerie.length < N + 1) planSerie.push(0);
    const minSerie = minimos.serie.slice(0, N + 1);
    while(minSerie.length < N + 1) minSerie.push(minSerie.length ? minSerie[minSerie.length - 1] : 0);

    const ctx = canvas.getContext('2d');
    if(chartDebtSim){ chartDebtSim.destroy(); chartDebtSim = null; }
    chartDebtSim = new Chart(ctx, {
      type:'line',
      data:{
        labels,
        datasets:[
          {label:'Solo mínimos', data:minSerie, borderColor:'#8a1f1c', backgroundColor:'rgba(138,31,28,.06)',
            borderWidth:2, borderDash:[5,4], fill:true, tension:.25, pointRadius:0},
          {label:'Tu plan', data:planSerie, borderColor:'#0e4d3a', backgroundColor:'rgba(14,77,58,.1)',
            borderWidth:2.5, fill:true, tension:.25, pointRadius:0}
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:true,
        interaction:{mode:'index', intersect:false},
        plugins:{
          legend:{position:'bottom', labels:{font:{family:'Geist',size:11,weight:'500'}, boxWidth:14, padding:14, color:'#2b2b2e', usePointStyle:true, pointStyle:'line'}},
          tooltip:{backgroundColor:'#0c0c0d', titleColor:'#fff', bodyColor:'#fff', padding:12, cornerRadius:10,
            titleFont:{family:'Geist',weight:'600',size:12}, bodyFont:{family:'JetBrains Mono',size:12},
            callbacks:{title:items=>'Mes '+items[0].dataIndex, label:ctx=>' '+ctx.dataset.label+': '+fmt(ctx.parsed.y)}}
        },
        scales:{
          x:{grid:{display:false}, ticks:{font:{family:'JetBrains Mono',size:10}, color:'#8a8a8a', maxRotation:0, autoSkip:true, maxTicksLimit:8}},
          y:{grid:{color:'rgba(0,0,0,.05)'}, ticks:{font:{family:'JetBrains Mono',size:10}, color:'#8a8a8a',
            callback:v=> v>=1e6 ? (v/1e6).toFixed(0)+'M' : v>=1e3 ? (v/1e3).toFixed(0)+'k' : v}}
        }
      }
    });
  }

  /* Resumen del plan de pago — usado por el Tablero (M6) para volcar el resultado del simulador */
  function computeDebtPlanSummary(){
    const ds = state.debtSim || {};
    const base = (ds.deudas || []).filter(d => d.saldo > 0.5).map((d,idx) => ({
      id: d.id, nombre: d.nombre || 'Deuda', saldo: d.saldo, em: eaToMonthly(d.tasa),
      pago: d.pago, consolidar: d.consolidar, tasa: d.tasa, orden: idx
    }));
    if(!base.length) return {hasData:false};
    const abonos = {};
    if(ds.abonoMonto > 0) abonos[Math.max(1, ds.abonoMes || 1)] = ds.abonoMonto;
    let processed;
    if(ds.consolidacionActiva){
      const r = aplicarConsolidacion(base, (ds.consolidacionTasa||0)/100, ds.consolidacionPlazo||36);
      processed = r.lista;
    } else { processed = base.map(d=>({...d})); }
    const ordering = ds.estrategia || 'avalancha';
    const plan = simularDeuda(processed, ds.capacidadExtra||0, ordering, abonos, {rollover:true, useExtra:true});
    // El orden mostrado es el ORDEN DE ATAQUE (el que configuraste), no el de fecha de pago.
    const payoffById = {};
    plan.deudas.forEach(d => { payoffById[d.id] = d.payoffMes; });
    const orden = ordenarEstrategia(processed, ordering)
      .filter(d => d.saldo > 0.5)
      .map(d => ({ nombre: d.nombre, id: d.id, payoffMes: payoffById[d.id] }));
    return {hasData:true, estrategia:ds.estrategia||'avalancha', label:planLabel(), mes:plan.mes, estancado:plan.estancado, totalInteres:plan.totalInteres, orden};
  }

  /* ═══════════════════════════════════════════════════════════
     REGLA DE PRESUPUESTO (50/30/20) + REPARTO EN PAREJA (Tablero)
     ═══════════════════════════════════════════════════════════ */
  const RULE_TARGETS = {'50/30/20':{nec:50,des:30,aho:20},'60/20/20':{nec:60,des:20,aho:20},'70/20/10':{nec:70,des:20,aho:10}};
  const DEFAULT_BUCKET = {vivienda:'nec',alimentacion:'nec',transporte:'nec',salud:'nec',comunicaciones:'nec',entretenimiento:'des',otros:'des'};

  function gastoBucket(cat){
    const br = state.tablero.budgetRule || {};
    return (br.buckets && br.buckets[cat]) || DEFAULT_BUCKET[cat] || 'des';
  }
  function ruleTargets(){
    const br = state.tablero.budgetRule || {};
    if(br.rule === 'custom') return br.custom || {nec:50,des:30,aho:20};
    return RULE_TARGETS[br.rule] || RULE_TARGETS['50/30/20'];
  }
  function ingresoMensualHogar(){ return (state.ingresos||[]).reduce((s,i)=>s+(i.monto||0),0); }
  function gastoMensualTotal(){ return Object.values(state.gastos||{}).reduce((a,b)=>a+(b||0),0); }
  function deudaServicioMensual(){ return (state.deudas||[]).reduce((s,d)=>s+(d.cuota_mensual||0),0); }
  /* Superávit mensual real: lo que queda libre tras gastos, cuotas mínimas y ahorro */
  function superavitMensual(){
    const ing = ingresoMensualHogar();
    const gas = Object.values(state.gastos||{}).reduce((s,v)=>s+(v||0),0);
    const cuotas = deudaServicioMensual();
    const aho = (state.ahorro||[]).reduce((s,a)=>s+(a.monto_mensual||0),0);
    return ing - gas - cuotas - aho;
  }

  function renderBudgetRule(){
    const br = state.tablero.budgetRule;
    document.querySelectorAll('#t6-rule-seg .rule-seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.rule===br.rule));
    const customBox = document.getElementById('t6-rule-custom');
    if(customBox){
      customBox.style.display = br.rule==='custom' ? 'grid' : 'none';
      if(br.rule==='custom'){
        document.getElementById('rule-nec').value = br.custom.nec;
        document.getElementById('rule-des').value = br.custom.des;
        document.getElementById('rule-aho').value = br.custom.aho;
      }
    }
    renderBudgetBuckets();
    renderBudgetRuleResult();
  }

  function renderBudgetRuleResult(){
    const cont = document.getElementById('t6-rule-result'); if(!cont) return;
    // Ingreso base: mensual del hogar + ingresos no mensuales prorrateados (primas, dividendos)
    const ingreso = ingresoMensualHogar() + (state.p5.ingAnual||0)/12;
    // Ahorro real: excluye el aporte a provisiones (eso fondea gastos anuales, no es ahorro/inversión)
    const provisionAporte = (state.ahorro||[]).filter(a=>a.linkedToProvisionesAporte).reduce((s,a)=>s+(a.monto_mensual||0),0);
    let nec = deudaServicioMensual();
    let des = 0;
    let aho = (state.ahorro||[]).reduce((s,a)=>s+(a.monto_mensual||0),0) - provisionAporte;
    Object.entries(state.gastos||{}).forEach(([cat,val])=>{
      const b = gastoBucket(cat);
      if(b==='nec') nec += (val||0); else if(b==='aho') aho += (val||0); else des += (val||0);
    });
    // Gastos anuales del Presupuesto Anual (no marcados "ya en Ingresos y Gastos"), prorrateados a mensual y clasificados
    Object.values(state.p5.gastos||{}).forEach(rows=>{
      (rows||[]).forEach(r=>{
        if(r.frec !== 'NO ES TODOS LOS MESES') return;
        if(r.yaEnM1) return;   // ya está sumado en los gastos mensuales de Ingresos y Gastos
        const mensual = (r.monto||0)/12;
        if(mensual<=0) return;
        if(r.bucket === 'des') des += mensual; else nec += mensual;
      });
    });
    // Abono extra a deuda comprometido desde el simulador (capa reversible, solo el monto incremental)
    const planDeuda = state.tablero.planDeuda || {};
    const abonoExtraDeuda = (planDeuda.activo && planDeuda.extraMensual > 0) ? planDeuda.extraMensual : 0;
    aho += abonoExtraDeuda;
    const targets = ruleTargets();
    const sumT = (+targets.nec||0)+(+targets.des||0)+(+targets.aho||0);
    if(ingreso<=0){ cont.innerHTML='<div class="rule-empty">Registra tu ingreso mensual en el Módulo 1 para ver tu regla.</div>'; return; }
    const rows=[
      {key:'nec',label:'Necesidades',amt:nec,tgt:+targets.nec||0,color:'var(--accent,#0e4d3a)'},
      {key:'des',label:'Deseos',amt:des,tgt:+targets.des||0,color:'#8a5a14'},
      {key:'aho',label:'Ahorro/inversión',amt:aho,tgt:+targets.aho||0,color:'#1f6f8b',
        note: abonoExtraDeuda>0 ? ('Incluye '+fmt(abonoExtraDeuda)+' de abono extra a deuda de tu simulador') : ''}
    ];
    let html='';
    if(sumT!==100) html+='<div class="rule-warn">'+SVG_WARN+'<span>Tus porcentajes suman '+sumT+'% (deberían sumar 100%).</span></div>';
    const exceso = (nec+des+aho) - ingreso;
    if(exceso > 0.5) html+='<div class="rule-warn">'+SVG_WARN+'<span>Tu plan asigna <strong>'+fmt(exceso)+' más</strong> de lo que ganas al mes. Para sostenerlo tendrías que <strong>ajustar tus gastos</strong>.</span></div>';
    rows.forEach(r=>{
      const actualPct = r.amt/ingreso*100;
      const targetAmt = ingreso*r.tgt/100;
      let verdict, vClass;
      if(r.key==='aho'){
        if(r.amt>=targetAmt){ verdict='Vas bien · '+fmt(r.amt-targetAmt)+' por encima de la meta'; vClass='pos'; }
        else { verdict='Te faltan '+fmt(targetAmt-r.amt)+' para la meta'; vClass='warn'; }
      } else {
        if(r.amt<=targetAmt){ verdict='Dentro de la meta · '+fmt(targetAmt-r.amt)+' de margen'; vClass='pos'; }
        else { verdict=fmt(r.amt-targetAmt)+' por encima de la meta'; vClass='warn'; }
      }
      html+='<div class="rule-row">'
        +'<div class="rule-row-top"><span class="rule-name">'+r.label+'</span>'
        +'<span class="rule-amt">'+fmt(r.amt)+' · '+actualPct.toFixed(0)+'% <span class="rule-tgt">(meta '+r.tgt+'%)</span></span></div>'
        +'<div class="rule-bar"><div class="rule-bar-fill" style="width:'+Math.min(actualPct,100).toFixed(1)+'%;background:'+r.color+'"></div>'
        +'<span class="rule-bar-marker" style="left:'+Math.min(r.tgt,100)+'%"></span></div>'
        +'<div class="rule-verdict '+vClass+'">'+verdict+'</div>'
        +(r.note ? '<div class="rule-note">'+r.note+'</div>' : '')
        +'</div>';
    });
    cont.innerHTML=html;
  }

  function renderBudgetBuckets(){
    const cont=document.getElementById('t6-rule-buckets'); if(!cont) return;
    let html='<p class="rule-bucket-note">Las cuotas mínimas de deuda cuentan como Necesidad y el ahorro del Módulo 4 como Ahorro/inversión. Reclasifica tus gastos si lo necesitas:</p>';
    Object.keys(state.gastos||{}).forEach(cat=>{
      const b=gastoBucket(cat);
      html+='<div class="bucket-row"><span>'+gastoLabel(cat)+'</span>'
        +'<select data-bucket-cat="'+cat+'">'
        +'<option value="nec"'+(b==='nec'?' selected':'')+'>Necesidad</option>'
        +'<option value="des"'+(b==='des'?' selected':'')+'>Deseo</option>'
        +'<option value="aho"'+(b==='aho'?' selected':'')+'>Ahorro</option>'
        +'</select></div>';
    });
    cont.innerHTML=html;
    cont.querySelectorAll('select[data-bucket-cat]').forEach(sel=>{
      sel.addEventListener('change',function(){
        if(!state.tablero.budgetRule.buckets) state.tablero.budgetRule.buckets={};
        state.tablero.budgetRule.buckets[this.dataset.bucketCat]=this.value;
        renderBudgetRuleResult(); scheduleSave('tablero');
      });
    });
  }

  function renderCouple(){
    const cont=document.getElementById('t6-pareja'); if(!cont) return;
    const nombre1=(state.p5.socio1||'Socio 1'), nombre2=(state.p5.socio2||'Socio 2');
    const c=state.tablero.couple;
    const ingresoHogar=ingresoMensualHogar();
    const compartidoAuto=gastoMensualTotal()+deudaServicioMensual();
    const i1 = c.ingreso1!=null ? c.ingreso1 : ingresoHogar;
    const i2 = c.ingreso2!=null ? c.ingreso2 : 0;
    const comp = c.compartido!=null ? c.compartido : compartidoAuto;
    cont.innerHTML =
      '<div class="cpl-grid">'
      + '<div class="mr-field"><label>Nombre</label><input type="text" id="cpl-nom1" value="'+String(nombre1).replace(/"/g,'&quot;')+'"></div>'
      + '<div class="mr-field"><label>Ingreso neto mensual</label><input class="money-input" id="cpl-ing1"></div>'
      + '<div class="mr-field"><label>Nombre</label><input type="text" id="cpl-nom2" value="'+String(nombre2).replace(/"/g,'&quot;')+'"></div>'
      + '<div class="mr-field"><label>Ingreso neto mensual</label><input class="money-input" id="cpl-ing2"></div>'
      + '</div>'
      + '<div class="mr-field" style="margin-top:10px"><label>Gasto del hogar al mes (compartido)</label><input class="money-input" id="cpl-comp"></div>'
      + '<div class="rule-seg" id="cpl-modo" style="margin-top:12px">'
      + '<button class="rule-seg-btn'+(c.modo!=='mitad'?' active':'')+'" data-modo="proporcional" type="button">Proporcional al ingreso</button>'
      + '<button class="rule-seg-btn'+(c.modo==='mitad'?' active':'')+'" data-modo="mitad" type="button">Mitad y mitad</button>'
      + '</div>'
      + '<div id="cpl-result"></div>';
    const ing1El=document.getElementById('cpl-ing1'); ing1El.value=i1>0?fmtInput(i1):''; ing1El.placeholder=fmtInput(ingresoHogar)||'0'; attachMoneyInput(ing1El);
    const ing2El=document.getElementById('cpl-ing2'); ing2El.value=i2>0?fmtInput(i2):''; attachMoneyInput(ing2El);
    const compEl=document.getElementById('cpl-comp'); compEl.value=comp>0?fmtInput(comp):''; compEl.placeholder=fmtInput(compartidoAuto)||'0'; attachMoneyInput(compEl);
    function syncMoney(){
      state.tablero.couple.ingreso1 = ing1El.value.trim()!==''? n(ing1El.value):null;
      state.tablero.couple.ingreso2 = ing2El.value.trim()!==''? n(ing2El.value):null;
      state.tablero.couple.compartido = compEl.value.trim()!==''? n(compEl.value):null;
      renderCoupleResult(); scheduleSave('tablero');
    }
    [ing1El,ing2El,compEl].forEach(el=>el.addEventListener('input',syncMoney));
    document.getElementById('cpl-nom1').addEventListener('input',function(){ state.p5.socio1=this.value; const s=document.getElementById('socio1'); if(s)s.value=this.value; renderCoupleResult(); scheduleSave('presupuesto_anual'); });
    document.getElementById('cpl-nom2').addEventListener('input',function(){ state.p5.socio2=this.value; const s=document.getElementById('socio2'); if(s)s.value=this.value; renderCoupleResult(); scheduleSave('presupuesto_anual'); });
    document.querySelectorAll('#cpl-modo .rule-seg-btn').forEach(b=>b.addEventListener('click',function(){
      state.tablero.couple.modo=this.dataset.modo;
      document.querySelectorAll('#cpl-modo .rule-seg-btn').forEach(x=>x.classList.remove('active'));
      this.classList.add('active');
      renderCoupleResult(); scheduleSave('tablero');
    }));
    renderCoupleResult();
  }

  function renderCoupleResult(){
    const cont=document.getElementById('cpl-result'); if(!cont) return;
    const c=state.tablero.couple;
    const nombre1=(state.p5.socio1||'Socio 1'), nombre2=(state.p5.socio2||'Socio 2');
    const i1 = c.ingreso1!=null ? c.ingreso1 : ingresoMensualHogar();
    const i2 = c.ingreso2!=null ? c.ingreso2 : 0;
    const comp = c.compartido!=null ? c.compartido : (gastoMensualTotal()+deudaServicioMensual());
    const total=i1+i2;
    if(total<=0){ cont.innerHTML='<div class="rule-empty">Ingresa el ingreso de cada quien para ver el reparto.</div>'; return; }
    const prop = c.modo!=='mitad';
    const share1=prop? i1/total : 0.5;
    const share2=prop? i2/total : 0.5;
    const ap1=comp*share1, ap2=comp*share2;
    let html='<div class="cpl-result-cards">';
    [[nombre1,i1,share1,ap1],[nombre2,i2,share2,ap2]].forEach(arr=>{
      const nm=arr[0], ing=arr[1], sh=arr[2], ap=arr[3];
      html+='<div class="cpl-card"><div class="cpl-name">'+nm+'</div>'
        +'<div class="cpl-line">Aporta <strong>'+fmt(ap)+'</strong> ('+(sh*100).toFixed(0)+'%)</div>'
        +'<div class="cpl-line cpl-left">Le queda <strong>'+fmt(ing-ap)+'</strong></div></div>';
    });
    html+='</div>';
    html+='<div class="cpl-note">'+SVG_INFO+'<div>'+(prop
      ? 'Con <strong>mitad y mitad</strong> cada uno aportaría '+fmt(comp/2)+'. El reparto proporcional suele ser más justo cuando los ingresos difieren.'
      : 'Con reparto <strong>proporcional</strong>, '+nombre1+' aportaría '+fmt(comp*(total>0?i1/total:0.5))+' y '+nombre2+' '+fmt(comp*(total>0?i2/total:0.5))+', según su ingreso.')+'</div></div>';
    cont.innerHTML=html;
  }

  function renderTableroSimulador(){
    const cont = document.getElementById('t6-simulador');
    if(!cont) return;
    const ds = state.debtSim || {};
    if(ds.ocultarPlanTablero){
      cont.innerHTML = '<div class="t6-sim-empty">Quitaste tu plan de pago de deudas del tablero. <a href="#" id="t6-sim-show">Mostrarlo de nuevo</a> o edítalo en el <a href="#" data-go-m7>simulador</a>.</div>';
      const showLink = cont.querySelector('#t6-sim-show');
      if(showLink) showLink.addEventListener('click', e=>{ e.preventDefault(); state.debtSim.ocultarPlanTablero=false; if(typeof persistModule==='function') persistModule('simulador_deuda'); renderTableroSimulador(); });
      cont.querySelectorAll('[data-go-m7]').forEach(l => l.addEventListener('click', e=>{e.preventDefault();navigateTo(7);}));
      return;
    }
    const s = computeDebtPlanSummary();
    if(!s.hasData){
      cont.innerHTML = '<div class="t6-sim-empty">Aún no has configurado tu plan de pago de deudas. <a href="#" data-go-m7>Ábrelo en el simulador</a> para ver aquí tu fecha de libertad y el orden de ataque.</div>';
      const l = cont.querySelector('[data-go-m7]');
      if(l) l.addEventListener('click', e=>{e.preventDefault();navigateTo(7);});
      return;
    }
    let html = '<div class="t6-sim-head">'
      + '<div class="t6-sim-kpi"><div class="t6-sim-label">Estrategia</div><div class="t6-sim-strong">' + (s.label || stratLabel(s.estrategia)) + '</div></div>'
      + '<div class="t6-sim-kpi"><div class="t6-sim-label">Libre de deudas</div><div class="t6-sim-strong">' + (s.estancado ? 'No se liquida' : mesesATexto(s.mes)) + '</div>' + (s.estancado ? '' : '<div class="t6-sim-sub">' + fechaLibertad(s.mes) + '</div>') + '</div>'
      + '<div class="t6-sim-kpi"><div class="t6-sim-label">Intereses del plan</div><div class="t6-sim-strong">' + (s.estancado ? '—' : fmt(s.totalInteres)) + '</div></div>'
      + '</div>';
    if(s.orden.length){
      html += '<div class="t6-sim-order">';
      s.orden.forEach((d,i)=>{
        html += '<div class="t6-sim-step"><span class="t6-sim-num">' + (i+1) + '</span><span class="t6-sim-name">' + (d.nombre || 'Deuda') + '</span><span class="t6-sim-date">' + (d.payoffMes != null ? fechaLibertad(d.payoffMes) : 'No se liquida') + '</span></div>';
      });
      html += '</div>';
    }
    html += '<div class="t6-sim-actions"><a href="#" class="btn-link" data-go-m7>Editar en el simulador</a>'
      + '<button class="btn-ghost" id="t6-sim-copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Agregar a mi plan de acción</button></div>';
    cont.innerHTML = html;
    cont.querySelectorAll('[data-go-m7]').forEach(l => l.addEventListener('click', e=>{e.preventDefault();navigateTo(7);}));
    const btn = document.getElementById('t6-sim-copy');
    if(btn) btn.addEventListener('click', copiarPlanSimulador);
  }

  function copiarPlanSimulador(){
    const s = computeDebtPlanSummary();
    if(!s.hasData){ showToast('Primero define tus deudas en el simulador','info'); return; }
    let txt = '— Plan de pago de deudas (' + (s.label || stratLabel(s.estrategia)) + ') —\n';
    if(s.estancado){
      txt += 'Con el abono actual la deuda no se liquida; aumentar la capacidad de pago o consolidar.\n';
    } else {
      txt += 'Quedo libre de deudas en ' + mesesATexto(s.mes) + ' (' + fechaLibertad(s.mes) + ').\n';
      if(s.totalInteres) txt += 'Intereses estimados del plan: ' + fmt(s.totalInteres) + '.\n';
      txt += 'Orden de ataque (a cuál diriges primero el abono extra):\n';
      s.orden.forEach((d,i)=>{ txt += '  ' + (i+1) + '. ' + (d.nombre||'Deuda') + ' — ' + (d.payoffMes != null ? ('libre en ' + fechaLibertad(d.payoffMes)) : 'no se liquida en el horizonte') + '\n'; });
    }
    const ta = document.getElementById('t6-plan');
    if(!ta) return;
    const MARK = '— Plan de pago de deudas';
    // Quita cualquier bloque de plan de deudas anterior y conserva el resto de las notas
    const previos = (ta.value || '')
      .split(/\n{2,}/)
      .map(b => b.trim())
      .filter(b => b && !b.startsWith(MARK));
    previos.push(txt.trim());
    ta.value = previos.join('\n\n');
    state.tablero.plan = ta.value;
    // Al comprometer el plan, recién ahí persistimos el simulador y el plan de acción.
    if(typeof persistModule === 'function'){
      persistModule('simulador_deuda');
      scheduleSave('tablero');
    }
    showToast('Plan de deudas actualizado en tu plan de acción · guardado','success');
  }

  async function saveM7(){
    recalcDebtSim();
    await saveModule('simulador_deuda', state.debtSim);
    completedModules.add(7); updateProgress(); updateNavStatus();
    showModal('Plan guardado','Tu plan de pago de deudas se guardó correctamente.');
    showToast('Guardado','success');
  }

  /* ═══════════════════════════════════════════════════════════
     METAS CUANTIFICADAS + PROYECCIÓN DE PATRIMONIO (Módulo 8)
     ═══════════════════════════════════════════════════════════ */
  let chartProy = null;

  function computePatrimonioNeto(){
    const totalActivos = (state.activos||[]).reduce((s,a)=> s + (a.valor||0), 0);
    const totalDeuda   = (state.deudas||[]).reduce((s,d)=> s + (d.saldo||0), 0);
    return totalActivos - totalDeuda;
  }
  function ahorroMensualM4(){
    return (state.ahorro||[]).reduce((s,a)=> s + (a.monto_mensual||0), 0);
  }
  function mesesHastaFecha(fecha){
    if(!fecha) return null;
    const parts = String(fecha).split('-'); if(parts.length < 2) return null;
    const y = +parts[0], mo = +parts[1];
    if(!y || !mo) return null;
    const now = new Date();
    return (y - now.getFullYear()) * 12 + ((mo - 1) - now.getMonth());
  }
  function formatMesAnio(fecha){
    if(!fecha) return '';
    const parts = String(fecha).split('-'); if(parts.length < 2) return '';
    const mo = +parts[1];
    if(!mo || mo < 1 || mo > 12) return parts[0];
    return MES_NAMES_ES[mo-1] + ' ' + parts[0];
  }
  function metaFuenteOptions(sel){
    const opts = [
      {v:'manual', l:'Lo ingreso manualmente'},
      {v:'liquido_total', l:'Todos mis activos líquidos disponibles (módulo Activos)'},
      {v:'fondo_provisiones', l:'Fondo de provisiones (módulo Gastos no periódicos)'}
    ];
    if(state.varIncome && state.varIncome.active) opts.push({v:'fondo_estabilizacion', l:'Fondo de estabilización'});
    // Activos individuales: líquidos disponibles + restringidos (cesantías, etc. sirven para metas específicas como vivienda)
    (state.activos||[]).forEach(a=>{
      if(!a.nombre) return;
      const incluir = (a.tipo==='LÍQUIDO') || a.restringido;
      if(!incluir) return;
      const l = a.restringido ? ('Activo restringido · ' + a.nombre + ' (uso específico)') : ('Activo · ' + a.nombre);
      opts.push({v:'activo:'+a.nombre, l:l});
    });
    return opts.map(o=>'<option value="'+String(o.v).replace(/"/g,'&quot;')+'"'+(o.v===sel?' selected':'')+'>'+o.l+'</option>').join('');
  }
  function metaSaldoActual(m){
    const f = m.fuente || 'manual';
    if(f === 'manual') return m.saldoManual || 0;
    if(f === 'liquido_total') return (state.activos||[]).filter(a=>a.tipo==='LÍQUIDO' && !a.restringido).reduce((s,a)=>s+(a.valor||0),0);
    if(f === 'fondo_provisiones') return state.p5.fondoProvisiones || 0;
    if(f === 'fondo_estabilizacion') return (state.varIncome && state.varIncome.fondoActual) || 0;
    if(f.indexOf('activo:') === 0){ const nombre = f.slice(7); const a = (state.activos||[]).find(x=>x.nombre===nombre); return a ? (a.valor||0) : 0; }
    return m.saldoManual || 0;
  }
  // Ids estables para vincular metas desde el presupuesto (Fase C · integración).
  function metaEnsureIds(){ let ch=false; ((state.metas&&state.metas.items)||[]).forEach(m=>{ if(m && !m.id){ m.id='m'+pgGenId(); ch=true; } }); if(ch){ try{ scheduleSave('metas'); }catch(e){} } return ch; }
  function proyeccionPatrimonio(P0, aporteMensual, rDec, anios){
    const im = rDec > 0 ? Math.pow(1 + rDec, 1/12) - 1 : 0;
    let saldo = P0, aportado = P0;
    const serie = [{anio:0, saldo:P0, aportado:P0}];
    const N = Math.max(1, Math.min(anios, 60)) * 12;
    for(let m=1; m<=N; m++){
      saldo = saldo * (1 + im) + aporteMensual;
      aportado += aporteMensual;
      if(m % 12 === 0) serie.push({anio: m/12, saldo, aportado});
    }
    return {serie, final:saldo, aportado, rendimiento: saldo - aportado};
  }

  function seedMetas(){
    if(state.metas.seeded) return;
    if(state.metas.items && state.metas.items.length){ state.metas.seeded = true; return; }
    const pr = state.profile || {};
    let fechaRetiro = '';
    if(pr.edad != null && pr.edadRetiro != null && pr.edadRetiro > pr.edad){
      const now = new Date();
      fechaRetiro = (now.getFullYear() + (pr.edadRetiro - pr.edad)) + '-' + String(now.getMonth()+1).padStart(2,'0');
    }
    state.metas.items = [
      {nombre:'Fondo de emergencia', objetivo:0, fecha:'', fuente:'liquido_total', saldoManual:0, aporte:0},
      {nombre:'Cuota inicial de vivienda', objetivo:0, fecha:'', fuente:'manual', saldoManual:0, aporte:0},
      {nombre:'Retiro / libertad financiera', objetivo:0, fecha:fechaRetiro, fuente:'manual', saldoManual:0, aporte:0}
    ];
    state.metas.seeded = true;
  }

  function renderMetas(){
    seedMetas();
    const p = state.metas.proy || {};
    // Perfil: edad, dependientes, edad de retiro
    const pr = state.profile || {};
    const edadEl = document.getElementById('meta-edad'); if(edadEl) edadEl.value = pr.edad != null ? pr.edad : '';
    const depEl = document.getElementById('meta-dependientes'); if(depEl) depEl.value = pr.dependientes != null ? pr.dependientes : '';
    const retEl = document.getElementById('meta-edad-retiro'); if(retEl) retEl.value = pr.edadRetiro != null ? pr.edadRetiro : '';
    const notaEl = document.getElementById('meta-perfil-nota');
    let aniosRetiro = null;
    if(pr.edad != null && pr.edadRetiro != null && pr.edadRetiro > pr.edad){
      aniosRetiro = pr.edadRetiro - pr.edad;
      if(!p.aniosUserSet) p.anios = aniosRetiro;   // horizonte por defecto = años hasta el retiro
      if(notaEl) notaEl.textContent = 'Te faltan ' + aniosRetiro + ' años para tu retiro objetivo (' + pr.edadRetiro + '). Usamos ese horizonte en tu proyección.';
    } else if(notaEl){
      notaEl.textContent = pr.edad==null || pr.edadRetiro==null ? 'Completa tu edad y tu edad de retiro para personalizar la proyección.' : '';
    }
    const rendEl = document.getElementById('meta-proy-rend'); if(rendEl) rendEl.value = p.rendimiento != null ? p.rendimiento : 9;
    const aniosEl = document.getElementById('meta-proy-anios'); if(aniosEl) aniosEl.value = p.anios != null ? p.anios : 28;
    const iniEl = document.getElementById('meta-proy-inicial');
    if(iniEl){ iniEl.value = p.inicialOverride != null ? fmtInput(p.inicialOverride) : ''; if(!iniEl.dataset.money) attachMoneyInput(iniEl); }
    const apEl = document.getElementById('meta-proy-aporte');
    if(apEl){ apEl.value = p.aporteOverride != null ? fmtInput(p.aporteOverride) : ''; if(!apEl.dataset.money) attachMoneyInput(apEl); }
    renderMetasRows();
    recalcMetas();
  }

  function renderMetasRows(){
    const body = document.getElementById('metas-body');
    if(!body) return;
    body.innerHTML = '';
    const items = state.metas.items || [];
    if(!items.length){
      body.innerHTML = '<div class="meta-empty">Aún no tienes metas. Agrega una con el botón de abajo o usa un atajo.</div>';
      return;
    }
    items.forEach((m,i)=>{
      const card = document.createElement('div');
      card.className = 'meta-card';
      card.dataset.i = i;
      const manualHide = (m.fuente && m.fuente !== 'manual') ? ' hide' : '';
      card.innerHTML =
        '<div class="meta-head">'
        + '<button class="meta-drag" title="Arrastra para reordenar la meta">' + SVG_DRAG_HANDLE + '</button>'
        + '<input type="text" class="it-name" data-f="nombre" value="' + String(m.nombre||'').replace(/"/g,'&quot;') + '" placeholder="Nombre de la meta">'
        + '<button class="it-del" title="Quitar">' + SVG_X + '</button>'
        + '</div>'
        + '<div class="meta-grid">'
        + '<div class="mr-field"><label>Monto objetivo</label><input class="money-input" data-f="objetivo" placeholder="0"></div>'
        + '<div class="mr-field"><label>Fecha objetivo</label><input type="month" data-f="fecha" value="' + (m.fecha||'') + '"></div>'
        + '<div class="mr-field"><label>Saldo actual · fuente</label><select data-f="fuente">' + metaFuenteOptions(m.fuente||'manual') + '</select></div>'
        + '<div class="mr-field meta-manual-cell' + manualHide + '" data-manual><label>Saldo actual</label><input class="money-input" data-f="saldoManual" placeholder="0"></div>'
        + '<div class="mr-field"><label>Aporte mensual planeado</label><input class="money-input" data-f="aporte" placeholder="0"></div>'
        + '</div>'
        + '<div class="meta-progress" data-prog></div>';
      body.appendChild(card);
      const oIn = card.querySelector('input[data-f=objetivo]'); oIn.value = m.objetivo>0?fmtInput(m.objetivo):''; attachMoneyInput(oIn);
      const sIn = card.querySelector('input[data-f=saldoManual]'); sIn.value = m.saldoManual>0?fmtInput(m.saldoManual):''; attachMoneyInput(sIn);
      const aIn = card.querySelector('input[data-f=aporte]'); aIn.value = m.aporte>0?fmtInput(m.aporte):''; attachMoneyInput(aIn);
      card.querySelectorAll('input,select').forEach(el=>{ el.addEventListener('input', recalcMetas); el.addEventListener('change', recalcMetas); });
      card.querySelector('.it-del').addEventListener('click', ()=>{
        const nombre = (m.nombre||'').trim();
        showConfirm({
          title:'Eliminar meta',
          msg: nombre ? ('¿Eliminar la meta "'+nombre+'"?') : '¿Eliminar esta meta?',
          confirmText:'Eliminar', danger:true,
          onConfirm:()=>{ state.metas.items.splice(i,1); renderMetasRows(); recalcMetas(); }
        });
      });
      wireMetaDrag(card.querySelector('.meta-drag'), card, body);
    });
  }

  /* Arrastre para reordenar las metas (Módulo 8) */
  function wireMetaDrag(handle, card, body){
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      e.preventDefault();
      card.classList.add('meta-dragging');
      document.body.style.userSelect='none'; document.body.style.cursor='grabbing';
      function move(ev){
        const sibs = Array.from(body.querySelectorAll('.meta-card:not(.meta-dragging)'));
        let placed=false;
        for(const sib of sibs){ const r=sib.getBoundingClientRect(); if(ev.clientY < r.top + r.height/2){ body.insertBefore(card, sib); placed=true; break; } }
        if(!placed) body.appendChild(card);
      }
      function end(){
        document.removeEventListener('pointermove',move);
        document.removeEventListener('pointerup',end);
        document.removeEventListener('pointercancel',end);
        document.body.style.userSelect=''; document.body.style.cursor='';
        card.classList.remove('meta-dragging');
        // Reordenar state.metas.items según el nuevo orden del DOM
        const items = state.metas.items || [];
        const order = Array.from(body.querySelectorAll('.meta-card')).map(c => +c.dataset.i);
        state.metas.items = order.map(idx => items[idx]).filter(Boolean);
        renderMetasRows(); recalcMetas();
      }
      document.addEventListener('pointermove',move);
      document.addEventListener('pointerup',end);
      document.addEventListener('pointercancel',end);
    });
  }

  function recalcMetas(){
    metaEnsureIds();
    const items = state.metas.items || [];
    document.querySelectorAll('#metas-body .meta-card').forEach(card=>{
      const i = +card.dataset.i; const m = items[i]; if(!m) return;
      m.nombre = card.querySelector('input[data-f=nombre]').value;
      m.objetivo = n(card.querySelector('input[data-f=objetivo]').value);
      m.fecha = card.querySelector('input[data-f=fecha]').value;
      m.fuente = card.querySelector('select[data-f=fuente]').value;
      m.saldoManual = n(card.querySelector('input[data-f=saldoManual]').value);
      m.aporte = n(card.querySelector('input[data-f=aporte]').value);
      const manualCell = card.querySelector('[data-manual]');
      if(manualCell) manualCell.classList.toggle('hide', m.fuente !== 'manual');
      // Progreso
      const prog = card.querySelector('[data-prog]');
      const saldo = metaSaldoActual(m);
      const obj = m.objetivo || 0;
      const pctv = obj > 0 ? Math.min(saldo/obj, 1) : 0;
      const faltante = Math.max(0, obj - saldo);
      const meses = mesesHastaFecha(m.fecha);
      const aporteNec = (faltante > 0 && meses && meses > 0) ? faltante/meses : 0;
      const aportePlan = m.aporte || 0;
      let estado = '', estClass = '';
      if(obj <= 0){ estado = 'Define un monto objetivo para ver tu avance'; }
      else if(saldo >= obj){ estado = '¡Meta cumplida!'; estClass = 'pos'; }
      else if(meses != null && meses <= 0){ estado = 'La fecha objetivo ya pasó · ajusta el plazo'; estClass = 'neg'; }
      else if(aporteNec > 0 && aportePlan >= aporteNec){ estado = 'Vas en ritmo para lograrla a tiempo'; estClass = 'pos'; }
      else if(aporteNec > 0){ estado = 'Tu aporte planeado no alcanza el ritmo necesario'; estClass = 'warn'; }
      const barColor = saldo >= obj && obj > 0 ? 'var(--pos,#0e4d3a)' : 'var(--accent,#0e4d3a)';
      let html = '<div class="meta-bar-wrap"><div class="meta-bar"><div class="meta-bar-fill" style="width:' + (pctv*100).toFixed(1) + '%;background:' + barColor + '"></div></div><span class="meta-pct">' + (obj>0?(pctv*100).toFixed(1)+'%':'—') + '</span></div>';
      html += '<div class="meta-stats">';
      html += '<span>Tienes <strong>' + fmt(saldo) + '</strong>' + (obj>0?(' de ' + fmt(obj)):'') + '</span>';
      if(obj > 0) html += '<span>Faltan <strong>' + fmt(faltante) + '</strong></span>';
      if(meses != null && meses > 0) html += '<span>' + meses + ' meses · ' + formatMesAnio(m.fecha) + '</span>';
      if(aporteNec > 0) html += '<span>Aporte necesario: <strong>' + fmt(aporteNec) + '/mes</strong></span>';
      if(estado) html += '<span class="meta-estado ' + estClass + '">' + estado + '</span>';
      html += '</div>';
      if(prog) prog.innerHTML = html;
    });
    renderMetasResumen();
    renderProyeccion();
    scheduleSave('metas');
  }

  function renderMetasResumen(){
    const cont = document.getElementById('metas-resumen'); if(!cont) return;
    const items = (state.metas.items||[]).filter(m=>(m.objetivo||0) > 0);
    if(!items.length){ cont.innerHTML = ''; return; }
    let totObj=0, totSaldo=0, totNec=0;
    items.forEach(m=>{
      const saldo = Math.min(metaSaldoActual(m), m.objetivo);
      const faltante = Math.max(0, m.objetivo - metaSaldoActual(m));
      const meses = mesesHastaFecha(m.fecha);
      totObj += m.objetivo; totSaldo += saldo;
      if(faltante > 0 && meses && meses > 0) totNec += faltante/meses;
    });
    const pctTot = totObj>0 ? Math.min(totSaldo/totObj,1) : 0;
    cont.innerHTML =
      '<div class="kpi-grid">'
      + '<div class="kpi is-info"><div class="kpi-label">Suma de tus metas</div><div class="kpi-value">' + fmt(totObj) + '</div><div class="kpi-sub">' + (pctTot*100).toFixed(1) + '% ya alcanzado</div></div>'
      + '<div class="kpi is-pos"><div class="kpi-label">Ahorrado hacia metas</div><div class="kpi-value">' + fmt(totSaldo) + '</div><div class="kpi-sub">Saldos vinculados + manuales</div></div>'
      + '<div class="kpi span-2"><div class="kpi-label">Aporte mensual necesario · total</div><div class="kpi-value">' + fmt(totNec) + '</div><div class="kpi-sub">Para cumplir todas a tiempo</div></div>'
      + '</div>';
  }

  function renderProyeccion(){
    const autoInicial = computePatrimonioNeto();
    const autoAporte = ahorroMensualM4();
    const iniEl = document.getElementById('meta-proy-inicial');
    const apEl  = document.getElementById('meta-proy-aporte');
    const rendEl = document.getElementById('meta-proy-rend');
    const aniosEl = document.getElementById('meta-proy-anios');
    if(!iniEl) return;
    if(iniEl) iniEl.placeholder = fmtInput(autoInicial) || '0';
    if(apEl) apEl.placeholder = fmtInput(autoAporte) || '0';

    const inicialOverride = iniEl.value.trim() !== '' ? n(iniEl.value) : null;
    const aporteOverride  = apEl.value.trim() !== '' ? n(apEl.value) : null;
    const rend = parseFloat(rendEl.value); const rendVal = isNaN(rend) ? 9 : rend;
    const anios = Math.max(1, Math.min(parseInt(aniosEl.value) || 28, 60));
    state.metas.proy = Object.assign(state.metas.proy||{}, { rendimiento: rendVal, anios, inicialOverride, aporteOverride });

    const inicial = inicialOverride != null ? inicialOverride : autoInicial;
    const aporte  = aporteOverride  != null ? aporteOverride  : autoAporte;
    const r = proyeccionPatrimonio(inicial, aporte, rendVal/100, anios);

    const kpis = document.getElementById('meta-proy-kpis');
    if(kpis){
      const kpiV = v => '<div class="kpi-value kpi-v-split"><span class="kpi-cur">'+currency+'</span> '+fmtInput(v)+'</div>';
      kpis.innerHTML =
        '<div class="kpi-grid">'
        + '<div class="kpi is-info"><div class="kpi-label">Patrimonio neto hoy</div>' + kpiV(inicial) + '<div class="kpi-sub">Activos − deudas</div></div>'
        + '<div class="kpi is-pos span-2"><div class="kpi-label">Patrimonio proyectado a ' + anios + ' años</div>' + kpiV(r.final) + '<div class="kpi-sub">Aportando ' + fmt(aporte) + '/mes al ' + rendVal + '% anual</div></div>'
        + '<div class="kpi"><div class="kpi-label">Rendimiento generado</div>' + kpiV(r.rendimiento) + '<div class="kpi-sub">Lo que trabaja tu dinero</div></div>'
        + '</div>';
    }
    const nota = document.getElementById('meta-proy-nota');
    if(nota){
      nota.innerHTML = SVG_INFO + '<div>Proyección en pesos nominales: asume que reinviertes todo y mantienes el aporte mensual. El rendimiento real depende de tus inversiones y no descuenta inflación. Es una estimación para ilustrar el poder del interés compuesto, no una promesa de retorno.</div>';
    }
    renderProyeccionChart(r, anios);
    scheduleSave('metas');
  }

  function renderProyeccionChart(r, anios){
    const canvas = document.getElementById('meta-proy-chart'); if(!canvas) return;
    const labels = r.serie.map(p => 'Año ' + p.anio);
    const saldoData = r.serie.map(p => Math.round(p.saldo));
    const aportadoData = r.serie.map(p => Math.round(p.aportado));
    const ctx = canvas.getContext('2d');
    if(chartProy){ chartProy.destroy(); chartProy = null; }
    chartProy = new Chart(ctx, {
      type:'line',
      data:{ labels, datasets:[
        {label:'Total aportado', data:aportadoData, borderColor:'#a8a59e', backgroundColor:'rgba(168,165,158,.08)', borderWidth:2, borderDash:[5,4], fill:true, tension:.2, pointRadius:0},
        {label:'Patrimonio proyectado', data:saldoData, borderColor:'#0e4d3a', backgroundColor:'rgba(14,77,58,.12)', borderWidth:2.5, fill:true, tension:.2, pointRadius:0}
      ]},
      options:{
        responsive:true, maintainAspectRatio:true,
        interaction:{mode:'index', intersect:false},
        plugins:{
          legend:{position:'bottom', labels:{font:{family:'Geist',size:11,weight:'500'}, boxWidth:14, padding:14, color:'#2b2b2e', usePointStyle:true, pointStyle:'line'}},
          tooltip:{backgroundColor:'#0c0c0d', titleColor:'#fff', bodyColor:'#fff', padding:12, cornerRadius:10,
            titleFont:{family:'Geist',weight:'600',size:12}, bodyFont:{family:'JetBrains Mono',size:12},
            callbacks:{label:ctx=>' '+ctx.dataset.label+': '+fmt(ctx.parsed.y)}}
        },
        scales:{
          x:{grid:{display:false}, ticks:{font:{family:'JetBrains Mono',size:10}, color:'#8a8a8a', maxRotation:0, autoSkip:true, maxTicksLimit:8}},
          y:{grid:{color:'rgba(0,0,0,.05)'}, ticks:{font:{family:'JetBrains Mono',size:10}, color:'#8a8a8a',
            callback:v=> v>=1e6 ? (v/1e6).toFixed(0)+'M' : v>=1e3 ? (v/1e3).toFixed(0)+'k' : v}}
        }
      }
    });
  }

  function addMeta(nombre){
    if((state.metas.items||[]).length >= 20){ showToast('Máximo 20 metas','error'); return; }
    state.metas.items.push({id:'m'+pgGenId(), nombre:nombre||'', objetivo:0, fecha:'', fuente:'manual', saldoManual:0, aporte:0});
    renderMetasRows(); recalcMetas();
    const last = document.querySelector('#metas-body .meta-card:last-child input[data-f=nombre]');
    if(last && !nombre) last.focus();
  }

  async function saveMetas(){
    recalcMetas();
    await saveModule('metas', state.metas);
    completedModules.add(8); updateProgress(); updateNavStatus();
    showModal('Metas guardadas','Tus metas y proyección se guardaron correctamente.');
    showToast('Guardado','success');
  }

  /* ═══════════════════════════════════════════════════════════
     PERSISTENCIA
     ═══════════════════════════════════════════════════════════ */
  async function saveModule(name,data){
    if(!firestoreAvailable||!userId){
      localStorage.setItem(`abba_${userId}_${name}`,JSON.stringify(data));
      return;
    }
    try{
      await db.collection('clientes').doc(userId).collection('modulos').doc(name)
        .set({...data,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    }catch(e){
      localStorage.setItem(`abba_${userId}_${name}`,JSON.stringify(data));
    }
  }
  async function loadModule(name){
    if(!firestoreAvailable||!userId){
      const d=localStorage.getItem(`abba_${userId}_${name}`);
      return d?JSON.parse(d):null;
    }
    try{
      const doc=await db.collection('clientes').doc(userId).collection('modulos').doc(name).get();
      return doc.exists?doc.data():null;
    }catch(e){
      const d=localStorage.getItem(`abba_${userId}_${name}`);
      return d?JSON.parse(d):null;
    }
  }
  
  /* ═══════════════════════════════════════════════════════════
     AUTOGUARDADO EN TIEMPO REAL (Firestore)
     ═══════════════════════════════════════════════════════════ */
  const NAME_TO_ID = {ingresos_gastos:1, endeudamiento:2, activos:3, ahorro:4, presupuesto_anual:5, tablero:6, simulador_deuda:7, metas:8, ingresos_variables:'var', fiscal:10};
  const _saveTimers = {};
  const _lastSaved = {};
  let _autosaveReady = false;   // se activa tras la carga inicial (evita guardar durante el render inicial)

  function moduleData(name){
    switch(name){
      case 'ingresos_gastos':{
        const totalIng = (state.ingresos||[]).reduce((s,i)=>s+(i.monto||0),0);
        const totalGas = Object.values(state.gastos||{}).reduce((a,b)=>a+(b||0),0);
        const gs = gastosForSave();
        return {
          fuentes_ingreso:(state.ingresos||[]).filter(ing=>!ing.linkedToMVar).map(ing=>({nombre:ing.nombre,monto:ing.monto})),
          gastos:gs.gastos, gastosLabels:gs.gastosLabels, gastosItems:gs.gastosItems, gastosOrder:gs.gastosOrder,
          tipoIngreso:state.profile.tipoIngreso, total_ingresos:totalIng, total_gastos:totalGas
        };
      }
      case 'endeudamiento': return {deudas:state.deudas};
      case 'activos': {
        const md = (window.MapaPatrimonial && window.MapaPatrimonial.getData) ? window.MapaPatrimonial.getData() : null;
        if(md) return {trm:md.trm, activos:md.activos};
        return state.mapaPatrimonial || {trm:{}, activos:[]};
      }
      case 'ahorro': return {objetivos_ahorro:state.ahorro, cupos_disponibles: state.cuposDisponibles||0};
      case 'presupuesto_anual': return state.p5;
      case 'tablero': return state.tablero;
      case 'simulador_deuda': return state.debtSim;
      case 'metas': return state.metas;
      case 'ingresos_variables': return state.varIncome;
      case 'fiscal': return state.fiscal;
      case 'presupuesto': return state.presupuesto;
    }
    return null;
  }

  function scheduleSave(name){
    if(!_autosaveReady) return;
    clearTimeout(_saveTimers[name]);
    _saveTimers[name] = setTimeout(()=>persistModule(name), 700);
  }

  async function persistModule(name){
    const data = moduleData(name);
    if(data == null) return;
    let json = null;
    try{ json = JSON.stringify(data); }catch(_){ }
    if(json != null && _lastSaved[name] === json) return; // sin cambios reales → no escribir
    _lastSaved[name] = json;
    setAutosaveStatus('saving');
    try{
      await saveModule(name, data);
      if(name === 'presupuesto_anual'){ try{ await regenerateEventosCliente(); }catch(_){ } }
      const id = NAME_TO_ID[name];
      if(id != null){ completedModules.add(id); updateProgress(); updateNavStatus(); }
      setAutosaveStatus('saved');
    }catch(e){
      setAutosaveStatus('error');
    }
  }

  /* Píldora de estado de guardado (flotante) */
  let _autosavePill = null, _autosaveHideTimer = null;
  function setAutosaveStatus(status){
    if(!_autosavePill){
      _autosavePill = document.createElement('div');
      _autosavePill.id = 'autosave-pill';
      _autosavePill.className = 'autosave-pill';
      document.body.appendChild(_autosavePill);
    }
    clearTimeout(_autosaveHideTimer);
    if(status === 'saving'){
      _autosavePill.textContent = 'Guardando…';
      _autosavePill.className = 'autosave-pill show';
    } else if(status === 'saved'){
      _autosavePill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg> Guardado';
      _autosavePill.className = 'autosave-pill show saved';
      _autosaveHideTimer = setTimeout(()=>_autosavePill.classList.remove('show'), 1400);
    } else {
      _autosavePill.textContent = 'Sin conexión · guardado local';
      _autosavePill.className = 'autosave-pill show error';
      _autosaveHideTimer = setTimeout(()=>_autosavePill.classList.remove('show'), 2600);
    }
  }

  /* Perfil del cliente: vive en clientes/{uid} (raíz, no en una subcolección) */
  async function savePerfil(uid, perfilData){
    if(!firestoreAvailable||!uid){
      localStorage.setItem(`abba_${uid}_perfil`, JSON.stringify(perfilData));
      return;
    }
    try{
      await db.collection('clientes').doc(uid).set({
        ...perfilData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, {merge:true});
    }catch(e){
      console.warn('savePerfil falló, fallback a localStorage:', e);
      localStorage.setItem(`abba_${uid}_perfil`, JSON.stringify(perfilData));
    }
  }
  async function loadPerfil(uid){
    if(!firestoreAvailable||!uid){
      const d=localStorage.getItem(`abba_${uid}_perfil`);
      return d?JSON.parse(d):null;
    }
    try{
      const doc=await db.collection('clientes').doc(uid).get();
      return doc.exists?doc.data():null;
    }catch(e){
      const d=localStorage.getItem(`abba_${uid}_perfil`);
      return d?JSON.parse(d):null;
    }
  }
  /* Persistencia del perfil tras edición (debounced) */
  let _perfilTimer = null;
  function profilePayload(){
    const p = state.profile || {};
    return {
      nombre:p.nombre||'', email:p.email||'', whatsapp:p.whatsapp||'', tipoIngreso:p.tipoIngreso||'',
      edad:(p.edad!=null?p.edad:null), dependientes:(p.dependientes!=null?p.dependientes:null), edadRetiro:(p.edadRetiro!=null?p.edadRetiro:null),
      consentimientoTratamiento:p.consentimientoTratamiento, consentimientoRecomendaciones:p.consentimientoRecomendaciones
    };
  }
  function persistPerfilDebounced(){
    clearTimeout(_perfilTimer);
    _perfilTimer = setTimeout(()=>{ if(state.profile && state.profile.uid) savePerfil(state.profile.uid, profilePayload()); }, 800);
  }

  async function loadAllData(){
    showToast('Cargando tus datos…','info');
    await cargarConfigFiscal();   // Fase 0: deja FISCAL listo (con respaldo) antes de renderizar cualquier módulo
    const [m1,m2,m3,m4,m5,m6,mVar,mSim,mMetas] = await Promise.all(
      ['ingresos_gastos','endeudamiento','activos','ahorro','presupuesto_anual','tablero','ingresos_variables','simulador_deuda','metas']
      .map(m=>loadModule(m))
    );
    if(m1){
      if(m1.fuentes_ingreso) state.ingresos=m1.fuentes_ingreso;
      if(m1.gastos) state.gastos = {...m1.gastos};   // reemplazar (no fusionar) para respetar categorías eliminadas
      if(m1.gastosLabels) Object.assign(state.gastosLabels,m1.gastosLabels);
      if(m1.gastosItems && typeof m1.gastosItems==='object') state.gastosItems = m1.gastosItems;
      if(Array.isArray(m1.gastosOrder)) state.gastosOrder = m1.gastosOrder.slice();
      else if(m1.gastos) state.gastosOrder = Object.keys(m1.gastos);   // saves antiguos: orden derivado de las claves
      ensureGastosItems(); recomputeGastosTotales();
      if(m1.tipoIngreso) state.profile.tipoIngreso = m1.tipoIngreso;
      completedModules.add(1);
    }
    if(m2){if(m2.deudas) state.deudas=m2.deudas;completedModules.add(2);}
    if(m3){
      // Formato nuevo (Mapa Patrimonial): {trm, activos:[...ricos]}
      // Formato viejo (tabla simple): {activos:[{nombre,valor,tipo}]} -> se trata como mapa vacío
      // pero conservamos los activos viejos para que la función puente los exponga.
      if(Array.isArray(m3.activos) && m3.activos.some(a=>a && (a.category||a.subtype||a._sourceFormat))){
        state.mapaPatrimonial = {trm:m3.trm||{}, activos:m3.activos};
      } else if(Array.isArray(m3.activos)){
        // Migrar tabla simple vieja al formato del mapa (como bienes genéricos)
        state.mapaPatrimonial = {trm:{}, activos: m3.activos.map((a,i)=>({
          id:'leg_'+i+'_'+Math.random().toString(36).slice(2,7),
          category:'Financiero', subtype:'', description:a.nombre||'Activo',
          currency:'COP', value:a.valor||0, deudasVinculadas:[],
          liquidity: a.tipo==='LÍQUIDO'?'Alta':'Ilíquida',
          location:'Colombia', legalStructure:'Propiedad Directa',
          _sourceFormat:'legacy-tabla-simple', _debtMigrated:true,
        }))};
      } else {
        state.mapaPatrimonial = {trm:{}, activos:[]};
      }
      completedModules.add(3);
    } else { state.mapaPatrimonial = {trm:{}, activos:[]}; }
    if(m4){if(m4.objetivos_ahorro) state.ahorro=m4.objetivos_ahorro;if(m4.cupos_disponibles!=null) state.cuposDisponibles=+m4.cupos_disponibles||0;completedModules.add(4);}
    if(m5){state.p5={...state.p5,...m5};completedModules.add(5);}
    if(m6){Object.assign(state.tablero,m6);completedModules.add(6);}
    state.tablero.budgetRule = Object.assign({rule:'50/30/20',custom:{nec:50,des:30,aho:20},buckets:{}}, state.tablero.budgetRule||{});
    state.tablero.couple = Object.assign({ingreso1:null,ingreso2:null,compartido:null,modo:'proporcional'}, state.tablero.couple||{});
    if(mVar){Object.assign(state.varIncome, mVar);if(mVar.active)completedModules.add('var');}
    if(!Array.isArray(state.varIncome.contratos)) state.varIncome.contratos = [];
    delete state.varIncome.meses; delete state.varIncome.actividad; delete state.varIncome.tributoPct;
    if(mSim){
      state.debtSim = {...state.debtSim, ...mSim};
      // Migración: la consolidación dejó de ser un método; ahora es una capa independiente
      if(state.debtSim.estrategia === 'consolidacion'){
        state.debtSim.estrategia = 'avalancha';
        state.debtSim.consolidacionActiva = true;
      }
      if(!Array.isArray(state.debtSim.ordenPersonalizado)) state.debtSim.ordenPersonalizado = [];
      // Backfill de ids estables (datos guardados antes de los ids)
      (state.debtSim.deudas || []).forEach(d => { if(!d.id) d.id = genDebtId(); });
      if(mSim.deudas && mSim.deudas.length){ state.debtSim.seeded = true; completedModules.add(7); }
    }
    if(mMetas){
      state.metas = {...state.metas, ...mMetas, proy:{...state.metas.proy, ...(mMetas.proy||{})}};
      if(mMetas.items && mMetas.items.length){ state.metas.seeded = true; completedModules.add(8); }
    }
    const mFiscal = await loadModule('fiscal');
    if(mFiscal){
      const legalBase = state.fiscal.legal || {};
      const legalRemoto = mFiscal.legal || {};
      state.fiscal = {
        ...state.fiscal, ...mFiscal,
        resp:{ ...state.fiscal.resp, ...(mFiscal.resp||{}) },
        exterior:{ ...state.fiscal.exterior, ...(mFiscal.exterior||{}) },
        iva:{ ...state.fiscal.iva, ...(mFiscal.iva||{}) },
        segSocial:{ ...state.fiscal.segSocial, ...(mFiscal.segSocial||{}) },
        costoFiscal:{ ...(mFiscal.costoFiscal||{}) },
        legal:{                                // Módulo 13 · merge profundo
          ...legalBase, ...legalRemoto,
          testamento:{ ...(legalBase.testamento||{}), ...(legalRemoto.testamento||{}) },
          poderes:{ ...(legalBase.poderes||{}), ...(legalRemoto.poderes||{}) },
          segurosVida: Array.isArray(legalRemoto.segurosVida) ? legalRemoto.segurosVida.slice() : (legalBase.segurosVida || []),
          avalesTerceros:{ ...(legalBase.avalesTerceros||{}), ...(legalRemoto.avalesTerceros||{}) },
          pleitosVigentes:{ ...(legalBase.pleitosVigentes||{}), ...(legalRemoto.pleitosVigentes||{}) },
          cumplimientoExterior:{ ...(legalBase.cumplimientoExterior||{}), ...(legalRemoto.cumplimientoExterior||{}) },
          coberturas:{
            ...(legalBase.coberturas||{}), ...(legalRemoto.coberturas||{}),
            rcProfesional:{ ...((legalBase.coberturas||{}).rcProfesional||{}), ...((legalRemoto.coberturas||{}).rcProfesional||{}) },
            dyo:{ ...((legalBase.coberturas||{}).dyo||{}), ...((legalRemoto.coberturas||{}).dyo||{}) }
          },
          planSucesoral:{
            ...(legalBase.planSucesoral||{}), ...(legalRemoto.planSucesoral||{}),
            acciones:{ ...((legalBase.planSucesoral||{}).acciones||{}), ...((legalRemoto.planSucesoral||{}).acciones||{}) }
          }
        }
      };
      completedModules.add(10);
    }
    const mPre = await loadModule('presupuesto');
    if(mPre){
      state.presupuesto = {
        ...state.presupuesto, ...mPre,
        gastos:{ ...(mPre.gastos||{}) },
        ingresos:{ ...(mPre.ingresos||{}) }
      };
    }
    renderIngresosTable();calcM1();
    renderGastosTable('gastos-body');
    renderDeudasTable();calcM2();
    initMapaPatrimonial();renderActivosTable();calcM3();
    renderAhorroTable();calcM4();
    initP5();updateProgress();updateNavStatus();
    showToast('Datos cargados','success');
  }
  function initP5(){
    const s=state.p5;
    if(s.socio1) document.getElementById('socio1').value=s.socio1;
    if(s.socio2) document.getElementById('socio2').value=s.socio2;
  
    // Wire del saldo del fondo de provisiones
    const provInput = document.getElementById('prov-saldo-actual');
    if(provInput){
      provInput.value = s.fondoProvisiones>0 ? fmtInput(s.fondoProvisiones) : '';
      if(!provInput.dataset.money) attachMoneyInput(provInput);
      if(!provInput.dataset.bound){
        provInput.addEventListener('input', function(){
          state.p5.fondoProvisiones = n(this.value);
          calcProvisiones();
        });
        provInput.dataset.bound = '1';
      }
    }
  
    // Pre-carga inteligente de ingresos no mensuales según tipo de cliente
    if(s.ingresos && s.ingresos.length){
      populateP5Section('p5-ingresos-body',s.ingresos);
    } else if(state.profile && state.profile.tipoIngreso){
      const precarga = getP5IngresosPrecarga(state.profile.tipoIngreso);
      if(precarga.length){
        populateP5Section('p5-ingresos-body', precarga);
      }
    }
  
    if(s.ahorro?.length)   populateP5Section('p5-ahorro-body',s.ahorro);
    renderP5Deudas();
    renderP5GastosAccordions();calcP5Totals();
  
    // Sincronizar el select de tipo de ingreso con el state al cargar
    const tipoSel = document.getElementById('tipo-ingreso');
    if(tipoSel && state.profile && state.profile.tipoIngreso){
      tipoSel.value = state.profile.tipoIngreso;
    }

    // Primar el cache de "último guardado" con el estado cargado y activar el autoguardado.
    Object.keys(NAME_TO_ID).forEach(nm=>{ try{ _lastSaved[nm] = JSON.stringify(moduleData(nm)); }catch(_){ } });
    _autosaveReady = true;
  }
  
  /* Re-pre-cargar ingresos cuando cambia el tipo (si están vacíos) */
  function refreshP5IngresosPrecarga(){
    // Solo pre-carga si la sección de ingresos no mensuales está vacía
    const body = document.getElementById('p5-ingresos-body');
    if(!body) return;
    const existing = collectP5Rows('p5-ingresos-body');
    // Si el usuario ya escribió algo (montos > 0 o nombres custom), no sobrescribimos
    const hasUserData = existing.some(r => r.monto > 0 || (r.nombre && r.nombre.length > 3));
    if(hasUserData) return;
    const precarga = getP5IngresosPrecarga(state.profile.tipoIngreso);
    if(precarga.length){
      populateP5Section('p5-ingresos-body', precarga);
      calcP5Totals();
      showToast('Ingresos no mensuales pre-cargados','info');
    }
  }
  function collectP5State(){
    state.p5.socio1=document.getElementById('socio1').value;
    state.p5.socio2=document.getElementById('socio2').value;
    state.p5.ingresos=collectP5Rows('p5-ingresos-body');
    state.p5.deudas  =collectP5Rows('p5-deudas-body');
    state.p5.ahorro  =collectP5Rows('p5-ahorro-body');
    const g={};p5Cats().forEach(cat=>{g[cat.id]=collectP5Rows('p5-gas-'+cat.id+'-body');});
    state.p5.gastos=g;
  }
  function updateProgress(){
    document.getElementById('progress-bar').style.width = Math.min(100, completedModules.size/6*100)+'%';
  }
  function updateNavStatus(){
    [1,2,3,4,5,6,7,8,'var'].forEach(i=>{
      const sbItem=document.querySelector(`.sb-item[data-module="${i}"]`);
      const bbItem=document.querySelector(`.bb-item[data-module="${i}"]`);
      if(completedModules.has(i)){
        sbItem?.classList.add('done');bbItem?.classList.add('done');
      }else{
        sbItem?.classList.remove('done');bbItem?.classList.remove('done');
      }
    });
  }
  
  /* ═══════════════════════════════════════════════════════════
     SAVE HANDLERS
     ═══════════════════════════════════════════════════════════ */
  async function saveM1(){
    const {totalIng,totalGas}=calcM1();
    // calcM1 ya actualizó state.ingresos correctamente (incluye filas locked)
    const fuentes = state.ingresos.map(ing => ({
      nombre: ing.nombre,
      monto: ing.monto,
      esVariable: ing.esVariable || false
    }));
    const gs = gastosForSave();
    await saveModule('ingresos_gastos',{
      fuentes_ingreso:fuentes,
      gastos:gs.gastos,
      gastosLabels:gs.gastosLabels,
      gastosItems:gs.gastosItems,
      gastosOrder:gs.gastosOrder,
      tipoIngreso: state.profile.tipoIngreso,
      total_ingresos:totalIng,
      total_gastos:totalGas
    });
    completedModules.add(1);updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tus ingresos y gastos se guardaron correctamente.');showToast('Guardado','success');
  }
  async function saveM2(){
    calcM2();
    await saveModule('endeudamiento',{deudas:state.deudas});
    completedModules.add(2);updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tus deudas se guardaron correctamente.');showToast('Guardado','success');
  }
  // ════════════════════════════════════════════════════════════════════════════════
  // PUENTE CON EL MÓDULO MAPA PATRIMONIAL
  // ════════════════════════════════════════════════════════════════════════════════
  // Mapea un tipo de deuda del Mapa (texto libre por categoría) al tipo del M2.
  function mapaDebtTypeToM2(tipoMapa, categoriaActivo){
    const t = (tipoMapa||'').toLowerCase();
    if(/hipotec|habitacional|constructor/.test(t)) return 'APAL_HIPOTECA';
    if(/margin|apalancamiento|invertir|inversi[oó]n|empresarial|aval|fianza|negocio/.test(t)) return 'APAL_INVERSION';
    if(/tarjeta/.test(t)) return 'CONSUMO_TARJETA';
    if(/veh[ií]culo|leasing|prendario/.test(t)) return 'OTRO_VEHICULO';
    if(/libre inversi[oó]n/.test(t)) return 'CONSUMO_PRESTAMO';
    // Por categoría del activo si el tipo no fue claro
    if(categoriaActivo === 'Inmueble') return 'APAL_HIPOTECA';
    if(categoriaActivo === 'Empresarial' || categoriaActivo === 'Financiero') return 'APAL_INVERSION';
    if(categoriaActivo === 'Uso Personal') return 'OTRO_VEHICULO';
    return 'OTRO_PERSONAL';
  }

  function initMapaPatrimonial(){
    if(!window.MapaPatrimonial) return;
    const data = state.mapaPatrimonial || {trm:{}, activos:[]};
    window.MapaPatrimonial.init({
      data: data,
      host: {
        // Lee las deudas vivas del M2
        getDeudas: () => (state.deudas || []).map(d => ({id:d.id, nombre:d.nombre, saldo:d.saldo, grupo:d.grupo, tipo:d.tipo})),
        getDeudaById: (id) => (state.deudas || []).find(d => d.id === id) || null,
        // Crea una deuda nueva en el M2 (opción B) y devuelve su id
        createDeuda: (info) => {
          const id = genDebtId();
          const tipo = mapaDebtTypeToM2(info.tipoMapa, info.categoriaActivo);
          const nueva = {
            id,
            nombre: info.nombre || 'Deuda',
            saldo: info.saldo || 0,
            cuota_mensual: 0,
            tasa_anual: 0,
            tipo,
            grupo: debtGroup(tipo),
            cargos: [],
            origenMapa: true,
          };
          if(!Array.isArray(state.deudas)) state.deudas = [];
          state.deudas.push(nueva);
          // Re-render del M2 para que la fila aparezca allá, y persistir
          if(document.getElementById('deudas-body')){ renderDeudasTable(); }
          calcM2();
          saveModule('endeudamiento',{deudas:state.deudas});
          return id;
        },
        // Persiste los datos del Mapa (formato {trm, activos})
        persist: (payload) => {
          state.mapaPatrimonial = {trm:payload.trm||{}, activos:payload.activos||[]};
          scheduleSave('activos');
        },
        // El Mapa cambió -> recalcular módulos que dependen de activos
        onChange: () => { try{ calcM3(); }catch(e){} },
        // Modal de confirmación de la herramienta (en vez del confirm del navegador)
        confirm: (opts) => showConfirm(opts),
        // Toast de la herramienta (en vez del toast propio del Mapa)
        toast: (msg, type) => showToast(msg, type),
      }
    });
  }

  async function saveM3(){
    calcM3();
    const data = (window.MapaPatrimonial && window.MapaPatrimonial.getData)
      ? window.MapaPatrimonial.getData() : null;
    const payload = data ? {trm:data.trm, activos:data.activos} : (state.mapaPatrimonial||{trm:{},activos:[]});
    await saveModule('activos', payload);
    completedModules.add(3);updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tus activos se guardaron correctamente.');showToast('Guardado','success');
  }
  async function saveM4(){
    calcM4();
    await saveModule('ahorro',{objetivos_ahorro:state.ahorro, cupos_disponibles: state.cuposDisponibles||0});
    completedModules.add(4);updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tu ahorro se guardó correctamente.');showToast('Guardado','success');
  }
  async function saveM5(){
    collectP5State();calcP5Totals();
    await saveModule('presupuesto_anual',state.p5);
    completedModules.add(5);updateProgress();updateNavStatus();
    await regenerateEventosCliente();
    showModal('Módulo guardado','Tu módulo de gastos no periódicos se guardó correctamente.');showToast('Guardado','success');
  }
  async function saveM6(){
    await saveModule('tablero',state.tablero);
    completedModules.add(6);updateProgress();updateNavStatus();
    showModal('Tablero guardado','Tu tablero de control se guardó correctamente.');showToast('Guardado','success');
  }
  
  /* ═══════════════════════════════════════════════════════════
     GENERACIÓN DE EVENTOS — Vista materializada para el dashboard
     ═══════════════════════════════════════════════════════════ */
  
  /* Mapea nombre de gasto a tipo de evento según patrones */
  function clasificarTipoEvento(nombre){
    const n = (nombre||'').toLowerCase();
    if(n.includes('póliza de auto') || n.includes('todo riesgo') || n.includes('seguro de vehíc')) return 'renovacion_poliza_auto';
    if(n.includes('póliza de vida') || n.includes('seguro de vida')) return 'renovacion_poliza_vida';
    if(n.includes('seguro de hogar') || n.includes('póliza de hogar')) return 'renovacion_poliza_hogar';
    if(n.includes('medicina prepagada')) return 'renovacion_prepagada';
    if(n.includes('soat')) return 'vencimiento_soat';
    if(n.includes('predial')) return 'vencimiento_predial';
    if(n.includes('matrícula') || n.includes('matricula')) return 'matricula_colegio';
    if(n.includes('prima')) return 'prima_legal';
    if(n.includes('cesantía') || n.includes('cesantias')) return 'cesantias';
    if(n.includes('dividendos')) return 'dividendos';
    if(n.includes('devolución') || n.includes('retención')) return 'devolucion_retencion';
    if(n.includes('bonificación') || n.includes('utilidades')) return 'bonificacion';
    return 'otro_compromiso_anual';
  }
  
  /* Calcula la fecha esperada del próximo evento de un mes dado (1-12) */
  function calcularProximaFecha(mesNum){
    if(!mesNum || mesNum < 1 || mesNum > 12) return null;
    const hoy = new Date();
    const mesActual = hoy.getMonth() + 1;
    const yearTarget = (mesNum >= mesActual) ? hoy.getFullYear() : hoy.getFullYear() + 1;
    // Día 15 del mes como aproximación
    return new Date(yearTarget, mesNum - 1, 15);
  }
  
  /* Borra los eventos previos del cliente y genera los nuevos */
  async function regenerateEventosCliente(){
    if(!firestoreAvailable || !userId) return;
    // Si es un demo, NO escribir a Firestore
    if(userId.startsWith('demo_')) return;
    // Si el cliente no autorizó recomendaciones, no generar eventos comerciales
    const consRec = state.profile?.consentimientoRecomendaciones;
    if(!consRec || !consRec.aceptado) return;
  
    try {
      // 1. Borrar eventos previos del cliente (mejor reemplazar que mergear, simple y consistente)
      const prev = await db.collection('eventos').where('clienteUid','==',userId).get();
      const batch = db.batch();
      prev.forEach(doc => batch.delete(doc.ref));
  
      // 2. Recolectar gastos anuales del M5 con mes definido
      const eventos = [];
      const perfilDenorm = {
        clienteUid: userId,
        clienteNombre: state.profile?.nombre || '',
        clienteEmail: state.profile?.email || '',
        clienteWhatsapp: state.profile?.whatsapp || '',
        clienteTipoIngreso: state.profile?.tipoIngreso || ''
      };
  
      const gastosM5 = state.p5.gastos || {};
      Object.entries(gastosM5).forEach(([catId, items]) => {
        (items||[]).forEach(item => {
          if(item.frec !== 'NO ES TODOS LOS MESES') return;
          if(!item.mes || item.mes === 'varia' || item.mes === '') return;
          if(!item.monto || item.monto <= 0) return;
          const tipo = clasificarTipoEvento(item.nombre);
          const fechaEsperada = calcularProximaFecha(parseInt(item.mes));
          if(!fechaEsperada) return;
          eventos.push({
            ...perfilDenorm,
            tipo: tipo,
            categoriaM5: catId,
            concepto: item.nombre || '',
            fechaEsperada: firebase.firestore.Timestamp.fromDate(fechaEsperada),
            monto: item.monto,
            companiaActual: item.compania || '',
            formaPago: item.formaPago || 'contado',
            provisionado: !!item.provisionar,
            estado: 'pendiente',
            notasInternas: '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
      });
  
      // 3. Eventos especiales (no atados a un mes específico)
      // Déficit tributario detectado en el módulo de variables
      if(state.varIncome && state.varIncome.active && (state.varIncome.contratos||[]).length){
        let totalDebido = 0, totalReservado = 0;
        getCombinedMeses().forEach(m => {
          totalDebido += m.tributoSugerido || 0;
          totalReservado += m.tributo || 0;
        });
        const deficit = Math.max(0, totalDebido - totalReservado);
        if(deficit > 500000){
          // Apuntar al próximo abril (declaración de renta)
          const hoy = new Date();
          const abrilProx = hoy.getMonth() + 1 >= 4 ? hoy.getFullYear() + 1 : hoy.getFullYear();
          eventos.push({
            ...perfilDenorm,
            tipo: 'deficit_tributario',
            concepto: 'Déficit tributario acumulado',
            fechaEsperada: firebase.firestore.Timestamp.fromDate(new Date(abrilProx, 3, 15)),
            monto: deficit,
            estado: 'pendiente',
            notasInternas: '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      }
  
      // Fondo de emergencias bajo (< 3 meses de gastos)
      const totalLiquido = (state.activos||[]).filter(a=>a.tipo==='LÍQUIDO' && !a.linkedToFondo && !a.linkedToProvisiones).reduce((s,a)=>s+(a.valor||0),0);
      const totalGastosM = Object.values(state.gastos||{}).reduce((a,b)=>a+(b||0),0);
      const fondoMeses = totalGastosM>0 ? totalLiquido/totalGastosM : 0;
      if(totalGastosM > 0 && fondoMeses < 3){
        const hoy = new Date();
        eventos.push({
          ...perfilDenorm,
          tipo: 'fondo_emergencia_bajo',
          concepto: 'Fondo de emergencias por debajo de 3 meses',
          fechaEsperada: firebase.firestore.Timestamp.fromDate(hoy),
          monto: totalGastosM * 6 - totalLiquido,
          estado: 'pendiente',
          notasInternas: '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
  
      // 4. Escribir todos los eventos
      eventos.forEach(ev => {
        const ref = db.collection('eventos').doc();
        batch.set(ref, ev);
      });
  
      await batch.commit();
      console.log(`Eventos regenerados para ${userId}: ${eventos.length}`);
    } catch(err){
      console.warn('No se pudieron regenerar eventos:', err);
    }
  }
  
  /* ═══════════════════════════════════════════════════════════
     EVENTS
     ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     ONBOARDING — Captura inicial del perfil
     ═══════════════════════════════════════════════════════════ */
  let _onboardingUser = null;
  
  function showOnboardingPerfil(user){
    _onboardingUser = user;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.remove('show');
    document.getElementById('onboarding-screen').style.display = 'flex';
  
    // Pre-llenar datos del Auth
    const nombreInput = document.getElementById('ob-nombre');
    const emailInput = document.getElementById('ob-email');
    if(user.displayName) nombreInput.value = user.displayName;
    if(user.email) emailInput.value = user.email;
    // Foco en el primer campo vacío
    setTimeout(()=>{ nombreInput.focus(); }, 100);
  }
  
  /* Validar WhatsApp colombiano: 10 dígitos, comienza con 3 */
  function validateWhatsApp(value){
    const cleaned = (value||'').replace(/\D/g,'');
    if(cleaned.length === 0) return {ok:false, msg:'Ingresa tu número de WhatsApp'};
    if(cleaned.length !== 10) return {ok:false, msg:'El número debe tener 10 dígitos'};
    if(!cleaned.startsWith('3')) return {ok:false, msg:'En Colombia los celulares empiezan con 3'};
    return {ok:true, value:cleaned};
  }
  
  /* Format inline mientras escribe: agrupa 3-3-4 */
  document.getElementById('ob-whatsapp').addEventListener('input', function(e){
    let v = this.value.replace(/\D/g,'').slice(0,10);
    this.value = v;
    // Limpia error si existía
    document.getElementById('ob-whatsapp-error').style.display = 'none';
  });
  
  document.getElementById('btn-onboarding-continuar').addEventListener('click', async function(){
    const nombre = document.getElementById('ob-nombre').value.trim();
    const email = document.getElementById('ob-email').value.trim();
    const whatsapp = document.getElementById('ob-whatsapp').value.trim();
    const consTratamiento = document.getElementById('ob-consent-tratamiento').checked;
    const consRecomendaciones = document.getElementById('ob-consent-recomendaciones').checked;
    const errorEl = document.getElementById('ob-error');
    const wppErrorEl = document.getElementById('ob-whatsapp-error');
  
    errorEl.style.display = 'none';
    wppErrorEl.style.display = 'none';
  
    if(!nombre){
      errorEl.textContent = 'Ingresa tu nombre completo.';
      errorEl.style.display = 'block';
      return;
    }
  
    const wppCheck = validateWhatsApp(whatsapp);
    if(!wppCheck.ok){
      wppErrorEl.textContent = wppCheck.msg;
      wppErrorEl.style.display = 'flex';
      return;
    }
  
    if(!consTratamiento){
      errorEl.textContent = 'Para usar la app necesitas autorizar el tratamiento de tus datos personales.';
      errorEl.style.display = 'block';
      return;
    }
  
    this.disabled = true;
    this.innerHTML = 'Guardando…';
  
    const now = new Date().toISOString();
    const edad = parseInt(document.getElementById('ob-edad').value)||null;
    const dependientes = parseInt(document.getElementById('ob-dependientes').value);
    const edadRetiro = parseInt(document.getElementById('ob-edad-retiro').value)||null;
    const perfilData = {
      uid: _onboardingUser.uid,
      nombre: nombre,
      email: email,
      whatsapp: wppCheck.value,
      tipoIngreso: '',
      edad: edad,
      dependientes: isNaN(dependientes) ? null : dependientes,
      edadRetiro: edadRetiro,
      consentimientoTratamiento: {
        aceptado: true,
        fecha: now,
        version: '1.0'
      },
      consentimientoRecomendaciones: {
        aceptado: consRecomendaciones,
        fecha: now
      },
      createdAt: now
    };
  
    try {
      await savePerfil(_onboardingUser.uid, perfilData);
      state.profile = Object.assign(state.profile||{}, {
        uid: _onboardingUser.uid,
        nombre: nombre,
        email: email,
        whatsapp: wppCheck.value,
        edad: edad,
        dependientes: isNaN(dependientes) ? null : dependientes,
        edadRetiro: edadRetiro,
        consentimientoTratamiento: perfilData.consentimientoTratamiento,
        consentimientoRecomendaciones: perfilData.consentimientoRecomendaciones
      });
      document.getElementById('user-display').textContent = nombre;
      document.getElementById('user-avatar').textContent = nombre.charAt(0).toUpperCase();
      document.getElementById('onboarding-screen').style.display = 'none';
      document.getElementById('app').classList.add('show');
      await loadAllData();
      showToast('¡Bienvenido a ABBA!', 'success');
    } catch(err){
      errorEl.textContent = 'No pudimos guardar tu perfil. ' + (err.message || 'Intenta de nuevo.');
      errorEl.style.display = 'block';
      this.disabled = false;
      this.innerHTML = 'Continuar <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
    }
  });
  
  document.getElementById('link-aviso-privacidad').addEventListener('click', function(e){
    e.preventDefault();
    showModal('Aviso de privacidad',
      '<p style="font-size:13px;line-height:1.6;margin-bottom:12px"><strong>Responsable del tratamiento:</strong> ABBA Asesoría Financiera, con sede en Medellín, Colombia.</p>'
      +'<p style="font-size:13px;line-height:1.6;margin-bottom:12px"><strong>Finalidad:</strong> ABBA recolecta tus datos financieros para ofrecerte un análisis personalizado de tu situación, identificar oportunidades concretas de productos y servicios financieros relevantes para ti, y comunicarte cuando aplique.</p>'
      +'<p style="font-size:13px;line-height:1.6;margin-bottom:12px"><strong>Derechos:</strong> En cualquier momento puedes acceder, rectificar, actualizar o suprimir tus datos, así como revocar las autorizaciones que has dado, escribiéndonos al correo de contacto.</p>'
      +'<p style="font-size:13px;line-height:1.6;margin-bottom:12px"><strong>Compartición de datos:</strong> ABBA no comparte tus datos con terceros sin una autorización adicional específica.</p>'
      +'<p style="font-size:13px;line-height:1.6"><strong>Marco legal:</strong> Este tratamiento se rige por la Ley 1581 de 2012 y el Decreto 1377 de 2013 de Colombia.</p>'
    );
  });
  
  function showAuthPane(name){
    ['login','register','forgot'].forEach(p => {
      const el = document.getElementById('pane-'+p);
      if(el) el.style.display = (p===name) ? 'flex' : 'none';
    });
    // Limpiar mensajes de error al cambiar de pantalla
    ['auth-login-error','auth-register-error','auth-forgot-msg'].forEach(id=>{
      const el = document.getElementById(id);
      if(el){el.style.display='none';el.textContent='';el.classList.remove('is-success');}
    });
  }
  
  function setAuthError(elementId, message, isSuccess){
    const el = document.getElementById(elementId);
    if(!el) return;
    el.textContent = message;
    el.style.display = 'block';
    el.classList.toggle('is-success', !!isSuccess);
  }
  
  /* Bootstrap principal: cuando cambia el estado de auth, decide qué mostrar */
  async function onAuthStateChange(user){
    if(!user){
      // No hay sesión: mostrar pantalla de login
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app').classList.remove('show');
      showAuthPane('login');
      return;
    }
    // Usuario autenticado
    userId = user.uid;
    currency = 'COP $';
  
    // Cargar perfil para decidir si debe ir al onboarding o a la app
    let perfil = null;
    try {
      perfil = await loadPerfil(user.uid);
    } catch(e){ console.warn('Error cargando perfil:', e); }
  
    if(!perfil || !perfil.consentimientoTratamiento || !perfil.consentimientoTratamiento.aceptado){
      // Primer login: mostrar onboarding de perfil
      showOnboardingPerfil(user);
      return;
    }
  
    // Aplicar info del perfil al UI
    state.profile = Object.assign(state.profile||{}, {
      uid: user.uid,
      nombre: perfil.nombre || user.displayName || user.email,
      email: perfil.email || user.email,
      whatsapp: perfil.whatsapp || '',
      tipoIngreso: perfil.tipoIngreso || '',
      edad: perfil.edad != null ? perfil.edad : null,
      dependientes: perfil.dependientes != null ? perfil.dependientes : null,
      edadRetiro: perfil.edadRetiro != null ? perfil.edadRetiro : null,
      consentimientoTratamiento: perfil.consentimientoTratamiento,
      consentimientoRecomendaciones: perfil.consentimientoRecomendaciones || {aceptado:false}
    });
  
    document.getElementById('user-display').textContent = state.profile.nombre;
    document.getElementById('user-avatar').textContent = (state.profile.nombre||'U').charAt(0).toUpperCase();
  
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.add('show');
    await loadAllData();
  }
  
  /* Login con email/password */
  document.getElementById('btn-login').addEventListener('click', async function(){
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if(!email || !password){
      setAuthError('auth-login-error', 'Completa correo y contraseña.');
      return;
    }
    this.disabled = true;
    this.textContent = 'Iniciando sesión…';
    try {
      await authService.loginEmail(email, password);
      // onAuthStateChange se dispara automáticamente
    } catch(err){
      setAuthError('auth-login-error', authService.prettyError(err));
      this.disabled = false;
      this.innerHTML = 'Iniciar sesión <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
    }
  });
  
  /* Login con Google */
  document.getElementById('btn-google-login').addEventListener('click', async function(){
    this.disabled = true;
    try {
      await authService.loginGoogle();
    } catch(err){
      setAuthError('auth-login-error', authService.prettyError(err));
      this.disabled = false;
    }
  });
  
  /* Registro con email/password */
  document.getElementById('btn-register').addEventListener('click', async function(){
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    if(!email || !password){
      setAuthError('auth-register-error', 'Completa correo y contraseña.');
      return;
    }
    if(password.length < 8){
      setAuthError('auth-register-error', 'La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    this.disabled = true;
    this.textContent = 'Creando cuenta…';
    try {
      await authService.registerEmail(email, password);
      // onAuthStateChange disparará el onboarding del perfil
    } catch(err){
      setAuthError('auth-register-error', authService.prettyError(err));
      this.disabled = false;
      this.innerHTML = 'Crear cuenta <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
    }
  });
  
  /* Registro con Google */
  document.getElementById('btn-google-register').addEventListener('click', async function(){
    this.disabled = true;
    try {
      await authService.loginGoogle();
    } catch(err){
      setAuthError('auth-register-error', authService.prettyError(err));
      this.disabled = false;
    }
  });
  
  /* Recuperar contraseña */
  document.getElementById('btn-forgot').addEventListener('click', async function(){
    const email = document.getElementById('forgot-email').value.trim();
    if(!email){
      setAuthError('auth-forgot-msg', 'Ingresa tu correo electrónico.');
      return;
    }
    this.disabled = true;
    this.textContent = 'Enviando…';
    try {
      await authService.sendPasswordReset(email);
      setAuthError('auth-forgot-msg', 'Te enviamos un correo para restablecer tu contraseña. Revisa tu bandeja de entrada.', true);
      this.disabled = false;
      this.textContent = 'Enviar enlace de recuperación';
    } catch(err){
      setAuthError('auth-forgot-msg', authService.prettyError(err));
      this.disabled = false;
      this.textContent = 'Enviar enlace de recuperación';
    }
  });
  
  /* Navegación entre paneles de auth */
  document.getElementById('link-to-register').addEventListener('click', function(e){e.preventDefault();showAuthPane('register');});
  document.getElementById('link-to-login').addEventListener('click', function(e){e.preventDefault();showAuthPane('login');});
  document.getElementById('link-forgot').addEventListener('click', function(e){e.preventDefault();showAuthPane('forgot');});
  document.getElementById('link-back-to-login').addEventListener('click', function(e){e.preventDefault();showAuthPane('login');});
  
  /* Enter en los campos dispara los botones */
  document.getElementById('auth-password').addEventListener('keypress', e => {if(e.key==='Enter') document.getElementById('btn-login').click();});
  document.getElementById('reg-password').addEventListener('keypress', e => {if(e.key==='Enter') document.getElementById('btn-register').click();});
  document.getElementById('forgot-email').addEventListener('keypress', e => {if(e.key==='Enter') document.getElementById('btn-forgot').click();});
  
  /* Iniciar el listener de cambios de auth */
  authService.onChange(onAuthStateChange);
  
  /* Menú de usuario */
  document.getElementById('user-avatar').addEventListener('click', function(e){
    e.stopPropagation();
    const dd = document.getElementById('user-dropdown');
    dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('#topbar-user-menu')){
      document.getElementById('user-dropdown').style.display = 'none';
    }
  });
  document.getElementById('dd-logout').addEventListener('click', function(e){
    e.preventDefault();
    showConfirm({
      title:'Cerrar sesión',
      msg:'¿Quieres cerrar tu sesión?',
      confirmText:'Cerrar sesión', danger:true,
      onConfirm:async function(){
        completedModules.clear();
        await authService.logout();
        setTimeout(()=>window.location.reload(), 200);
      }
    });
  });
  document.getElementById('dd-perfil').addEventListener('click', function(e){
    e.preventDefault();
    document.getElementById('user-dropdown').style.display = 'none';
    showToast('La pantalla de perfil estará disponible próximamente', 'info');
  });
  document.querySelectorAll('.sb-item, .bb-item').forEach(item=>{
    item.addEventListener('click',function(e){
      e.preventDefault();
      const m = this.dataset.module;
      navigateTo(isNaN(m) ? m : parseInt(m));
    });
  });
  /* Los botones de "Guardar módulo" se eliminaron: el guardado es automático en tiempo real. */

  /* ── Wiring del Simulador de Deuda (Módulo 7) ── */
  /* ds-capacidad y ds-abono-monto se cablean en renderDebtSim sobre el elemento vivo
     (garantiza que el cálculo reaccione al pago extra). Aquí solo los campos simples. */
  ['ds-cons-tasa','ds-cons-plazo','ds-abono-mes'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('input', recalcDebtSim);
  });
  document.querySelectorAll('#ds-strat .ds-strat-btn').forEach(btn=>{
    btn.addEventListener('click', function(){
      state.debtSim.estrategia = this.dataset.strat;
      document.querySelectorAll('#ds-strat .ds-strat-btn').forEach(b=>b.classList.remove('active'));
      this.classList.add('active');
      document.getElementById('modulo-7').classList.toggle('ds-personal-mode', state.debtSim.estrategia==='personalizada');
      recalcDebtSim();
      requestAnimationFrame(()=>{
        const card = document.getElementById('ds-order-card');
        if(card) card.scrollIntoView({behavior:'smooth', block:'start'});
      });
    });
  });
  // Interruptor de compra de cartera (capa independiente del orden)
  (function(){
    const t = document.getElementById('ds-cons-toggle');
    if(t) t.addEventListener('change', function(){
      state.debtSim.consolidacionActiva = this.checked;
      renderDebtSim();   // re-render completo: cambia el render de las filas (casillas "Unificar")
    });
  })();
  document.getElementById('ds-add-deuda').addEventListener('click', function(){
    state.debtSim.customized = true;
    state.debtSim.deudas.push({id:genDebtId(),nombre:'',saldo:0,tasa:0,pago:0,consolidar:false});
    renderDebtSimRows(); recalcDebtSim();
  });
  document.getElementById('ds-reload').addEventListener('click', function(){
    seedDebtSimFromM2(); state.debtSim.customized = false; renderDebtSimRows(); recalcDebtSim();
    showToast('Deudas recargadas desde tu diagnóstico','info');
  });

  /* ── Wiring de Metas y Proyección (Módulo 8) ── */
  /* save-m8 eliminado: autoguardado en tiempo real */
  const addMetaBtn = document.getElementById('meta-add');
  if(addMetaBtn) addMetaBtn.addEventListener('click', ()=> addMeta());
  document.querySelectorAll('#meta-chips [data-meta-chip]').forEach(chip=>{
    chip.addEventListener('click', ()=> addMeta(chip.dataset.metaChip));
  });
  ['meta-proy-inicial','meta-proy-aporte','meta-proy-rend','meta-proy-anios'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', function(){ if(id==='meta-proy-anios') state.metas.proy.aniosUserSet=true; renderProyeccion(); });
  });
  /* Perfil editable desde Metas */
  (function(){
    const e = document.getElementById('meta-edad'), d = document.getElementById('meta-dependientes'), r = document.getElementById('meta-edad-retiro');
    function upd(){
      state.profile.edad = e.value.trim()!=='' ? (parseInt(e.value)||null) : null;
      const dv = parseInt(d.value); state.profile.dependientes = isNaN(dv) ? null : dv;
      state.profile.edadRetiro = r.value.trim()!=='' ? (parseInt(r.value)||null) : null;
      persistPerfilDebounced();
      const pr = state.profile, notaEl = document.getElementById('meta-perfil-nota');
      if(pr.edad!=null && pr.edadRetiro!=null && pr.edadRetiro>pr.edad){
        const aniosRetiro = pr.edadRetiro - pr.edad;
        state.metas.proy.anios = aniosRetiro;
        state.metas.proy.aniosUserSet = false;
        const aniosEl = document.getElementById('meta-proy-anios'); if(aniosEl) aniosEl.value = aniosRetiro;
        if(notaEl) notaEl.textContent = 'Te faltan ' + aniosRetiro + ' años para tu retiro objetivo (' + pr.edadRetiro + '). Usamos ese horizonte en tu proyección.';
      } else if(notaEl){
        notaEl.textContent = (pr.edad==null||pr.edadRetiro==null) ? 'Completa tu edad y tu edad de retiro para personalizar la proyección.' : '';
      }
      renderProyeccion();
    }
    [e,d,r].forEach(el=>{ if(el) el.addEventListener('input', upd); });
  })();

  /* ── Wiring de la Regla de presupuesto (Tablero) ── */
  document.querySelectorAll('#t6-rule-seg .rule-seg-btn').forEach(b=>b.addEventListener('click',function(){
    state.tablero.budgetRule.rule = this.dataset.rule;
    document.querySelectorAll('#t6-rule-seg .rule-seg-btn').forEach(x=>x.classList.remove('active'));
    this.classList.add('active');
    const cb = document.getElementById('t6-rule-custom');
    if(cb){
      cb.style.display = this.dataset.rule==='custom' ? 'grid' : 'none';
      if(this.dataset.rule==='custom'){
        const c = state.tablero.budgetRule.custom;
        document.getElementById('rule-nec').value = c.nec;
        document.getElementById('rule-des').value = c.des;
        document.getElementById('rule-aho').value = c.aho;
      }
    }
    renderBudgetRuleResult(); scheduleSave('tablero');
  }));
  ['rule-nec','rule-des','rule-aho'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', function(){
      const c = state.tablero.budgetRule.custom;
      const v = parseFloat(this.value)||0;
      if(id==='rule-nec') c.nec=v; else if(id==='rule-des') c.des=v; else c.aho=v;
      renderBudgetRuleResult(); scheduleSave('tablero');
    });
  });
  document.getElementById('add-ingreso').addEventListener('click',function(){
    if(state.ingresos.length>=15){showToast('Máximo 15 fuentes','error');return;}
    state.ingresos.push({nombre:'',monto:0});
    renderIngresosTable();calcM1();
  });
  document.getElementById('add-deuda').addEventListener('click',addDeudaRow);
  document.getElementById('add-gasto-cat').addEventListener('click',addGastoCategoria);
  document.getElementById('add-ahorro').addEventListener('click',addAhorroRow);
  document.getElementById('socio1').addEventListener('input',calcP5Totals);
  document.getElementById('socio2').addEventListener('input',calcP5Totals);
  
  document.getElementById('tipo-ingreso').addEventListener('change', function(){
    state.profile.tipoIngreso = this.value;
    // Si MVar está activo y ahora se marca empleado, dar advertencia suave
    if(this.value === 'empleado' && state.varIncome.active){
      showToast('Si tu ingreso es estable, tal vez no necesites el módulo de variables','info');
    }
    // Re-renderear M5 si está visible (afecta pre-cargas de ingresos no mensuales)
    if(typeof refreshP5IngresosPrecarga === 'function'){
      refreshP5IngresosPrecarga();
    }
  });
  
  /* INIT */
  renderIngresosTable();calcM1();
  renderGastosTable('gastos-body');
  renderDeudasTable();calcM2();
  initMapaPatrimonial();renderActivosTable();calcM3();
  renderAhorroTable();calcM4();
  renderP5GastosAccordions();calcP5Totals();
  
  /* ═══════════════════════════════════════════════════════════
     MÓDULO INGRESOS VARIABLES — Para independientes
     ═══════════════════════════════════════════════════════════ */
  
  let chartMVar = null;
  
  function generateRecent12Months(){
    const today = new Date();
    const months = [];
    for(let i=11;i>=0;i--){
      const d = new Date(today.getFullYear(), today.getMonth()-i, 1);
      const label = MES_NAMES_ES[d.getMonth()] + ' ' + d.getFullYear();
      months.push({label, bruto:0, costos:0, tributo:0, neto:0, monthIdx:d.getMonth(), anio:d.getFullYear()});
    }
    return months;
  }
  
  function vMean(arr){if(!arr.length) return 0; return arr.reduce((a,b)=>a+b,0)/arr.length;}
  function vMedian(arr){
    if(!arr.length) return 0;
    const s = [...arr].sort((a,b)=>a-b);
    const m = Math.floor(s.length/2);
    return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
  }
  function vPercentile(arr, p){
    if(!arr.length) return 0;
    const s = [...arr].sort((a,b)=>a-b);
    const idx = (p/100) * (s.length-1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if(lo===hi) return s[lo];
    return s[lo] + (s[hi]-s[lo]) * (idx-lo);
  }
  function vStdDev(arr){
    if(arr.length<2) return 0;
    const m = vMean(arr);
    const sq = arr.reduce((a,b)=>a + (b-m)*(b-m), 0);
    return Math.sqrt(sq / (arr.length-1));
  }
  function vTrend(arr){
    if(arr.length<3) return 0;
    const n = arr.length;
    const xMean = (n-1)/2;
    const yMean = vMean(arr);
    let num=0, den=0;
    for(let i=0;i<n;i++){
      num += (i-xMean)*(arr[i]-yMean);
      den += (i-xMean)*(i-xMean);
    }
    const slope = den ? num/den : 0;
    return yMean ? slope*n/yMean : 0;
  }
  
  /* Salario personal sugerido (P25 redondeado a 50.000 abajo) */
  /* Factory de contrato nuevo */
  function nuevoContrato(){
    return {
      id: 'c' + Date.now() + Math.floor(Math.random()*1000),
      nombre: '',
      tipo: 'prestacion_servicios',
      retencionAplica: true,
      retencionPct: 11,
      meses: []
    };
  }

  /* Recalcular neto de UN mes según la retención de SU contrato */
  function recalcMesNetoC(c, mes){
    const pct = c.retencionAplica ? (c.retencionPct||0)/100 : 0;
    const tributoReal = c.retencionAplica ? Math.max(0, mes.tributo||0) : 0;
    mes.tributoSugerido = Math.round((mes.bruto||0) * pct);
    mes.tributoDeficit  = Math.max(0, mes.tributoSugerido - tributoReal);
    mes.neto = Math.max(0, (mes.bruto||0) - (mes.costos||0) - tributoReal);
    return mes.neto;
  }

  /* --- Período de un mes (año + mes), independiente de la etiqueta editable --- */
  /* Normaliza: asegura mes.anio y mes.monthIdx. Migra filas viejas leyendo la etiqueta. */
  function normalizarMesPeriodo(mes){
    if(mes.monthIdx==null || isNaN(mes.monthIdx)){
      // intentar deducir el mes desde la etiqueta
      if(mes.label){
        const low = (''+mes.label).toLowerCase();
        for(let k=0;k<MES_NAMES_ES.length;k++){ if(low.indexOf(MES_NAMES_ES[k].toLowerCase())>=0){ mes.monthIdx=k; break; } }
      }
      if(mes.monthIdx==null || isNaN(mes.monthIdx)) mes.monthIdx = new Date().getMonth();
    }
    if(mes.anio==null || isNaN(mes.anio)){
      let yr=null;
      if(mes.label){ const ym=(''+mes.label).match(/(20\d{2})/); if(ym) yr=parseInt(ym[1]); }
      mes.anio = (yr!=null) ? yr : new Date().getFullYear();
    }
    return mes;
  }
  function mesKey(mes){ normalizarMesPeriodo(mes); return mes.anio*12 + mes.monthIdx; }
  function mesLabelFmt(mes){ normalizarMesPeriodo(mes); return MES_NAMES_ES[mes.monthIdx] + ' ' + mes.anio; }

  /* Combina los meses de TODOS los contratos por MES CALENDARIO (año+mes), no por texto.
     Cada pseudo-mes suma bruto/costos/tributo/neto/tributoSugerido de los contratos. Orden cronológico. */
  function getCombinedMeses(){
    const v = state.varIncome;
    const map = {};
    (v.contratos||[]).forEach(function(c){
      (c.meses||[]).forEach(function(m){
        recalcMesNetoC(c, m);
        const k = mesKey(m);
        if(!map[k]){
          map[k] = {key:k, label:mesLabelFmt(m), monthIdx:m.monthIdx, anio:m.anio,
                    bruto:0, costos:0, tributo:0, neto:0, tributoSugerido:0};
        }
        const p = map[k];
        p.bruto += m.bruto||0;
        p.costos += m.costos||0;
        p.tributo += m.tributo||0;
        p.neto += m.neto||0;
        p.tributoSugerido += m.tributoSugerido||0;
      });
    });
    return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return a.key-b.key;});
  }

  function getSalarioPersonalActual(){
    const v = state.varIncome;
    if(!v || !v.active) return 0;
    if(v.salarioOverride && v.salarioPersonal>0) return v.salarioPersonal;
    const meses = getCombinedMeses().filter(m => (m.bruto||0) > 0);
    if(meses.length<3) return v.salarioPersonal||0;
    const netos = meses.map(m => m.neto||0);
    const p25 = vPercentile(netos, 25);
    return p25 > 0 ? Math.floor(p25/50000)*50000 : 0;
  }

  /* Meta del fondo de estabilización según variabilidad combinada */
  /* Meta del fondo de ESTABILIZACIÓN: solo suaviza la fluctuación normal del ingreso.
     Fórmula: z · σ · √L  (z=1,65 ≈ 95%, σ = desv. estándar mensual del neto, L=6 meses).
     No cubre pérdida de contrato — eso es el fondo de emergencia (meta aparte). */
  function getFondoMetaActual(){
    const v = state.varIncome;
    if(!v || !v.active) return 0;
    const meses = getCombinedMeses().filter(m => (m.bruto||0) > 0);
    if(meses.length < 3) return 0;                 // sin historial suficiente, no estimamos
    const netos = meses.map(m => m.neto||0);
    const sigma = vStdDev(netos);                  // variabilidad absoluta en pesos
    const Z = 1.65, L = 6;
    const meta = Z * sigma * Math.sqrt(L);
    return meta > 0 ? Math.round(meta/50000)*50000 : 0;
  }
  
  /* Render principal */
  function renderMVar(){
    const v = state.varIncome;
    const activeEl = document.getElementById('mvar-active');
    if(!activeEl) return;
    activeEl.checked = v.active;
    document.getElementById('mvar-content').style.display = v.active ? 'block' : 'none';
    if(!v.active) return;

    const fondoEl = document.getElementById('mvar-fondo-actual');
    if(fondoEl){
      if(document.activeElement !== fondoEl) fondoEl.value = v.fondoActual>0 ? fmtInput(v.fondoActual) : '';
      if(!fondoEl.dataset.money) attachMoneyInput(fondoEl);
    }

    renderMVarContratos();
    renderMVarStats();
  }

  const MVAR_TIPOS = [
    ['prestacion_servicios','Prestación de servicios'],
    ['honorarios','Honorarios'],
    ['comercio','Comercio / Ventas'],
    ['freelance','Freelance / Creativo'],
    ['comisiones','Comisiones'],
    ['rentas','Rentas / Arriendos'],
    ['negocio','Negocio propio'],
    ['otros','Otros']
  ];

  /* Render de las tarjetas de contrato (cada una con su histórico y retención) */
  function renderMVarContratos(){
    const cont = document.getElementById('mvar-contratos');
    const v = state.varIncome;
    if(!cont) return;
    cont.innerHTML = '';

    if(!v.contratos.length){
      cont.innerHTML = '<div class="mvar-empty">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
        + '<p>Aún no has agregado contratos.<br>Usa <strong>"Agregar contrato"</strong> para registrar cada fuente variable (honorarios, comisiones, etc.).</p>'
        + '</div>';
      return;
    }

    v.contratos.forEach(function(c, ci){
      const card = document.createElement('div');
      card.className = 'card mvar-contrato';
      const tipoOpts = MVAR_TIPOS.map(function(t){
        return '<option value="' + t[0] + '"' + (c.tipo===t[0]?' selected':'') + '>' + t[1] + '</option>';
      }).join('');

      card.innerHTML = '<div class="mvar-contrato-head">'
        + '<span class="mvar-contrato-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg></span>'
        + '<input type="text" class="it-name mvar-contrato-nombre" data-f="nombre" value="' + (c.nombre||'') + '" placeholder="Nombre del contrato (ej: Honorarios Clínica X)">'
        + '<button class="it-del mvar-contrato-del" title="Eliminar contrato">' + SVG_X + '</button>'
        + '</div>'
        + '<div class="mvar-config-grid">'
        + '<div class="mr-field"><label>Tipo de contrato</label><select data-f="tipo">' + tipoOpts + '</select></div>'
        + '<div class="mr-field"><label>¿Te retienen en la fuente?</label>'
        +   '<label class="mvar-ret-toggle"><input type="checkbox" data-f="retencionAplica"' + (c.retencionAplica?' checked':'') + '> <span data-ret-label>' + (c.retencionAplica?'Sí, me retienen':'No me retienen') + '</span></label>'
        + '</div>'
        + '<div class="mr-field" data-ret-pct-wrap style="' + (c.retencionAplica?'':'display:none') + '"><label>% de retención <span class="info-tip" data-def="reserva_tributaria" tabindex="0">i</span></label><input type="number" data-f="retencionPct" min="0" max="50" step="0.5" placeholder="11" value="' + (c.retencionPct||'') + '"></div>'
        + '</div>'
        + '<div class="mvar-contrato-historial">'
        +   '<div class="mvar-hist-head"><span>Historial mensual</span><span class="head-meta" data-mes-count>' + c.meses.length + (c.meses.length===1?' mes':' meses') + '</span></div>'
        +   '<div data-meses-body></div>'
        +   '<div class="mvar-hist-actions">'
        +     '<button class="btn-add" data-add-mes><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Agregar mes</button>'
        +     '<button class="btn-ghost" data-fill-12>Crear 12 meses</button>'
        +     '<button class="btn-ghost" data-clear-mes>Limpiar</button>'
        +   '</div>'
        + '</div>';
      cont.appendChild(card);

      // --- wiring config ---
      const nombreIn = card.querySelector('input[data-f=nombre]');
      nombreIn.addEventListener('input', function(){ c.nombre = this.value; scheduleSave('ingresos_variables'); });

      const tipoSel = card.querySelector('select[data-f=tipo]');
      tipoSel.addEventListener('change', function(){ c.tipo = this.value; scheduleSave('ingresos_variables'); });

      const retChk = card.querySelector('input[data-f=retencionAplica]');
      const retLabel = card.querySelector('[data-ret-label]');
      const retPctWrap = card.querySelector('[data-ret-pct-wrap]');
      retChk.addEventListener('change', function(){
        c.retencionAplica = this.checked;
        retLabel.textContent = this.checked ? 'Sí, me retienen' : 'No me retienen';
        retPctWrap.style.display = this.checked ? '' : 'none';
        renderMVarContratos(); renderMVarStats(); propagateMVarChanges();
      });
      const retPctIn = card.querySelector('input[data-f=retencionPct]');
      if(retPctIn) retPctIn.addEventListener('input', function(){
        c.retencionPct = parseFloat(this.value)||0;
        renderMVarStats(); propagateMVarChanges();
      });

      // --- meses ---
      const mesesBody = card.querySelector('[data-meses-body]');
      const mesCountEl = card.querySelector('[data-mes-count]');
      renderContratoMeses(c, mesesBody, mesCountEl);

      card.querySelector('[data-add-mes]').addEventListener('click', function(){
        if(c.meses.length >= 24){ showToast('Máximo 24 meses por contrato','error'); return; }
        // por defecto: un mes antes del más antiguo registrado (o el mes actual si no hay)
        let baseAnio, baseMon;
        if(c.meses.length){
          c.meses.forEach(normalizarMesPeriodo);
          let minK = Infinity, minM=null;
          c.meses.forEach(function(m){ const k=mesKey(m); if(k<minK){minK=k;minM=m;} });
          const prev = new Date(minM.anio, minM.monthIdx-1, 1);
          baseAnio = prev.getFullYear(); baseMon = prev.getMonth();
        } else {
          const today=new Date(); baseAnio=today.getFullYear(); baseMon=today.getMonth();
        }
        c.meses.push({label:MES_NAMES_ES[baseMon]+' '+baseAnio, bruto:0,costos:0,tributo:0,neto:0,monthIdx:baseMon,anio:baseAnio});
        renderContratoMeses(c, mesesBody, mesCountEl); renderMVarStats(); scheduleSave('ingresos_variables');
      });
      card.querySelector('[data-fill-12]').addEventListener('click', function(){
        const apply=function(){
          c.meses = generateRecent12Months();
          renderContratoMeses(c, mesesBody, mesCountEl); renderMVarStats(); propagateMVarChanges();
        };
        if(c.meses.length>0){
          showConfirm({title:'Generar 12 meses', msg:'Esto reemplazará los meses de este contrato. ¿Continuar?', confirmText:'Reemplazar', danger:true, onConfirm:apply});
        } else apply();
      });
      card.querySelector('[data-clear-mes]').addEventListener('click', function(){
        if(!c.meses.length) return;
        showConfirm({title:'Borrar historial', msg:'¿Borrar el historial de este contrato?', confirmText:'Borrar', danger:true, onConfirm:function(){
          c.meses = [];
          renderContratoMeses(c, mesesBody, mesCountEl); renderMVarStats(); propagateMVarChanges();
        }});
      });
      card.querySelector('.mvar-contrato-del').addEventListener('click', function(){
        showConfirm({title:'Eliminar contrato', msg:'¿Eliminar este contrato y su historial?', confirmText:'Eliminar', danger:true, onConfirm:function(){
          v.contratos.splice(ci,1);
          renderMVarContratos(); renderMVarStats(); propagateMVarChanges();
        }});
      });
    });
  }

  /* Render de las filas de meses de UN contrato */
  function renderContratoMeses(c, body, countEl){
    body.innerHTML = '';
    if(countEl) countEl.textContent = c.meses.length + (c.meses.length===1?' mes':' meses');
    if(!c.meses.length){
      body.innerHTML = '<p class="mvar-hint" style="margin:6px 0 0">Sin meses. Usa "Crear 12 meses" o "Agregar mes".</p>';
      return;
    }
    // Ordenar cronológicamente por período (año+mes); la etiqueta de texto ya no manda
    c.meses.forEach(normalizarMesPeriodo);
    c.meses.sort(function(a,b){ return mesKey(a)-mesKey(b); });

    const retiene = c.retencionAplica;
    const hoyAnio = new Date().getFullYear();
    const anios = [];
    for(let y=hoyAnio-4; y<=hoyAnio+1; y++) anios.push(y);

    c.meses.forEach(function(mes, i){
      recalcMesNetoC(c, mes);
      const real = mes.tributo || 0;
      function hintHtml(){
        const sg = mes.tributoSugerido||0, df = mes.tributoDeficit||0, rl = mes.tributo||0;
        if(!retiene) return '<span class="trib-hint trib-hint-ok">Sin retención en este contrato</span>';
        if((mes.bruto||0)<=0) return '<span class="trib-hint">Sugerido: ' + (c.retencionPct||0) + '% del bruto</span>';
        if(rl===0) return '<span class="trib-hint trib-hint-bad">No apartaste nada · sugerido: ' + fmt(sg) + '</span>';
        if(df>0) return '<span class="trib-hint trib-hint-warn">Insuficiente · faltaron ' + fmt(df) + '</span>';
        return '<span class="trib-hint trib-hint-ok">Reserva suficiente</span>';
      }
      const mesOpts = MES_NAMES_ES.map(function(nm,idx){ return '<option value="'+idx+'"'+(idx===mes.monthIdx?' selected':'')+'>'+nm+'</option>'; }).join('');
      const anioOpts = anios.map(function(y){ return '<option value="'+y+'"'+(y===mes.anio?' selected':'')+'>'+y+'</option>'; }).join('');

      const row = document.createElement('div');
      row.className = 'mvar-mes-row';
      row.innerHTML = '<div class="mvar-mes-head">'
        + '<div class="mvar-mes-periodo"><select data-f="monthIdx" title="Mes">' + mesOpts + '</select><select data-f="anio" title="Año">' + anioOpts + '</select></div>'
        + '<span class="mvar-mes-neto" data-neto>' + fmt(mes.neto||0) + '</span>'
        + '<button class="it-del" title="Eliminar">' + SVG_X + '</button>'
        + '</div>'
        + '<div class="mvar-mes-grid">'
        + '<div class="mr-field"><label>Ingreso bruto</label><input class="money-input" data-f="bruto" placeholder="0"></div>'
        + '<div class="mr-field"><label>Costos del negocio</label><input class="money-input" data-f="costos" placeholder="0"></div>'
        + (retiene ? '<div class="mr-field full"><label>Retención · lo que apartaste</label><input class="money-input" data-f="tributo" placeholder="0"><div data-trib-hint>' + hintHtml() + '</div></div>'
                   : '<div class="mr-field full"><div data-trib-hint>' + hintHtml() + '</div></div>')
        + '</div>';
      body.appendChild(row);

      const brutoIn = row.querySelector('input[data-f=bruto]');
      const costosIn = row.querySelector('input[data-f=costos]');
      const tribIn = row.querySelector('input[data-f=tributo]');
      brutoIn.value = mes.bruto>0 ? fmtInput(mes.bruto) : '';
      costosIn.value = mes.costos>0 ? fmtInput(mes.costos) : '';
      if(tribIn) tribIn.value = real>0 ? fmtInput(real) : '';
      [brutoIn,costosIn,tribIn].forEach(function(el){ if(el) attachMoneyInput(el); });

      // Cambiar mes/año: actualiza período, re-ordena y re-renderiza
      const mesSel = row.querySelector('select[data-f=monthIdx]');
      const anioSel = row.querySelector('select[data-f=anio]');
      const onPeriodo = function(){
        mes.monthIdx = parseInt(mesSel.value);
        mes.anio = parseInt(anioSel.value);
        mes.label = MES_NAMES_ES[mes.monthIdx] + ' ' + mes.anio;
        renderContratoMeses(c, body, countEl);
        renderMVarStats();
        propagateMVarChanges();
      };
      mesSel.addEventListener('change', onPeriodo);
      anioSel.addEventListener('change', onPeriodo);

      const updateRow = function(){
        mes.bruto = n(brutoIn.value);
        mes.costos = n(costosIn.value);
        mes.tributo = tribIn ? n(tribIn.value) : 0;
        recalcMesNetoC(c, mes);
        row.querySelector('[data-neto]').textContent = fmt(mes.neto);
        const hintEl = row.querySelector('[data-trib-hint]');
        if(hintEl) hintEl.innerHTML = hintHtml();
        renderMVarStats();
        propagateMVarChanges();
      };
      [brutoIn,costosIn,tribIn].forEach(function(el){ if(el) el.addEventListener('input',updateRow); });
      row.querySelector('.it-del').addEventListener('click',function(){
        const idx = c.meses.indexOf(mes);
        if(idx>=0) c.meses.splice(idx,1);
        renderContratoMeses(c, body, countEl);
        renderMVarStats();
        propagateMVarChanges();
      });
    });
  }
  
  function renderMVarStats(){
    const v = state.varIncome;
    const meses = getCombinedMeses().filter(m => (m.bruto||0) > 0);
    const netos = meses.map(m => m.neto);
  
    const promedio = vMean(netos);
    const mediana  = vMedian(netos);
    const ingresoBaseSeguro = vPercentile(netos, 25);
    const ingresoPesimista  = vPercentile(netos, 10);
    const desviacion = vStdDev(netos);
    const variabilidad = promedio>0 ? desviacion/promedio : 0;
    const tendencia = vTrend(netos);
    const minNeto = netos.length ? Math.min(...netos) : 0;
    const maxNeto = netos.length ? Math.max(...netos) : 0;
  
    const salarioSugerido = ingresoBaseSeguro > 0 ? Math.floor(ingresoBaseSeguro/50000)*50000 : 0;
    const salarioActual = v.salarioOverride && v.salarioPersonal>0 ? v.salarioPersonal : salarioSugerido;
  
    renderMVarTributario(meses);
  
    const kpisEl = document.getElementById('mvar-kpis');
    if(meses.length < 3){
      kpisEl.innerHTML = '<div class="kpi span-2 is-warn">'
        + '<div class="kpi-label">Datos insuficientes</div>'
        + '<div class="kpi-value" style="font-size:18px">Registra al menos 3 meses</div>'
        + '<div class="kpi-sub">Necesitas mínimo 3 meses para análisis básico, idealmente 6 a 12 para recomendaciones sólidas.</div>'
        + '</div>';
      document.getElementById('mvar-salary-display').textContent = '—';
      renderMVarChart([],[],0);
      document.getElementById('mvar-recos').innerHTML = '<div class="mvar-empty"><p>Las recomendaciones aparecerán cuando tengas al menos 3 meses con datos.</p></div>';
      document.getElementById('mvar-stacion-card').style.display = 'none';
      renderMVarFondo(salarioActual, variabilidad);
      return;
    }
  
    const varClass = variabilidad<0.25 ? 'is-pos' : variabilidad<0.5 ? 'is-warn' : 'is-neg';
    const varLabel = variabilidad<0.25 ? 'Estable' : variabilidad<0.5 ? 'Variable' : 'Muy volátil';
    const varTag   = variabilidad<0.25 ? 'pos' : variabilidad<0.5 ? 'warn' : 'neg';
    const tendClass = tendencia>0.1 ? 'is-pos' : tendencia<-0.1 ? 'is-neg' : 'is-info';
    const tendLabel = tendencia>0.1 ? '↑ Creciente' : tendencia<-0.1 ? '↓ Decreciente' : '→ Estable';
  
    kpisEl.innerHTML = '<div class="kpi is-info">'
      + '<div class="kpi-label">Promedio mensual neto</div>'
      + '<div class="kpi-value">' + fmt(promedio) + '</div>'
      + '<div class="kpi-sub">Suma ÷ ' + meses.length + ' meses</div>'
      + '</div>'
      + '<div class="kpi"><div class="kpi-label">Mediana mensual neta</div><div class="kpi-value">' + fmt(mediana) + '</div><div class="kpi-sub">El mes "típico"</div></div>'
      + '<div class="kpi is-pos"><div class="kpi-label">Ingreso base seguro ' + tip('ingreso_base_seguro') + '</div><div class="kpi-value">' + fmt(ingresoBaseSeguro) + '</div><div class="kpi-sub">3 de cada 4 meses superan este nivel</div></div>'
      + '<div class="kpi is-neg"><div class="kpi-label">Escenario pesimista</div><div class="kpi-value">' + fmt(ingresoPesimista) + '</div><div class="kpi-sub">Solo 1 de cada 10 meses cae bajo este nivel</div></div>'
      + '<div class="kpi ' + varClass + '"><div class="kpi-label">Variabilidad de tu ingreso ' + tip('variabilidad') + '</div><div class="kpi-value">' + pct(variabilidad) + '</div><div class="kpi-tag ' + varTag + '">' + (variabilidad<0.25?SVG_CHECK:SVG_WARN) + varLabel + '</div></div>'
      + '<div class="kpi ' + tendClass + '"><div class="kpi-label">Tendencia de los últimos meses</div><div class="kpi-value" style="font-size:22px">' + tendLabel + '</div><div class="kpi-sub">' + (tendencia>0.1?'Tu ingreso viene subiendo':tendencia<-0.1?'Tu ingreso viene bajando':'Sin tendencia clara') + '</div></div>'
      + '<div class="kpi span-2"><div class="kpi-label">Rango histórico</div><div class="kpi-value" style="font-size:18px"><span style="color:var(--neg)">' + fmt(minNeto) + '</span> <span style="color:var(--ink-3);font-size:14px;margin:0 8px">a</span> <span style="color:var(--pos)">' + fmt(maxNeto) + '</span></div><div class="kpi-sub">Diferencia entre mejor y peor mes: ' + fmt(maxNeto-minNeto) + '</div></div>';
  
    const salaryDisp = document.getElementById('mvar-salary-display');
    const salaryMeta = document.getElementById('mvar-salary-meta');
    const salaryInput = document.getElementById('mvar-salary-input');
    const salaryPrefix = document.getElementById('mvar-salary-prefix');
    salaryPrefix.textContent = currency;
    salaryDisp.textContent = fmt(salarioActual);
  
    const mesesQueCumplen = netos.filter(x => x >= salarioActual).length;
    const cobertura = meses.length>0 ? mesesQueCumplen/meses.length : 0;
    salaryMeta.innerHTML = v.salarioOverride && v.salarioPersonal>0
      ? 'Tu valor personalizado · <strong>' + pct(cobertura) + ' de meses</strong> históricos lo soportan' + (cobertura<0.6?' — ⚠ riesgo alto':cobertura<0.75?' — atención':'')
      : 'Sugerido según tu ingreso base seguro · <strong>' + pct(cobertura) + ' de meses</strong> históricos lo soportan sin tocar el fondo';
  
    if(document.activeElement !== salaryInput){
      salaryInput.value = salarioActual>0 ? fmtInput(salarioActual) : '';
      if(!salaryInput.dataset.money) attachMoneyInput(salaryInput);
    }
  
    renderMVarChart(meses, netos, salarioActual);
  
    // Estacionalidad
    const stacionCard = document.getElementById('mvar-stacion-card');
    const byMonth = {};
    meses.forEach(m=>{
      if(m.monthIdx==null) return;
      if(!byMonth[m.monthIdx]) byMonth[m.monthIdx] = [];
      byMonth[m.monthIdx].push(m.neto);
    });
    const desviaciones = [];
    Object.entries(byMonth).forEach(function(entry){
      const idx = entry[0]; const arr = entry[1];
      if(arr.length<1) return;
      const avgMes = vMean(arr);
      const delta = promedio>0 ? (avgMes-promedio)/promedio : 0;
      if(Math.abs(delta) >= 0.15){
        desviaciones.push({idx:parseInt(idx), delta:delta, avg:avgMes});
      }
    });
    if(desviaciones.length && meses.length>=8){
      desviaciones.sort((a,b)=>a.delta-b.delta);
      const html = desviaciones.map(function(d){
        const cls = d.delta<0 ? 'low' : 'high';
        const sign = d.delta>0 ? '+' : '';
        return '<div class="season-row ' + cls + '">'
          + '<span class="season-month">' + MES_NAMES_FULL[d.idx] + '</span>'
          + '<span style="color:var(--ink-3);font-size:12.5px">' + fmt(d.avg) + '</span>'
          + '<span class="season-delta">' + sign + (d.delta*100).toFixed(0) + '% vs promedio</span>'
          + '</div>';
      }).join('');
      document.getElementById('mvar-stacion-body').innerHTML = html
        + '<p class="mvar-hint" style="margin-top:14px">En los meses bajos, el fondo de estabilización debe absorber la caída. Aprovecha los meses altos para reforzarlo antes de los bajos.</p>';
      stacionCard.style.display = 'block';
    } else {
      stacionCard.style.display = 'none';
    }
  
    renderMVarFondo(salarioActual, variabilidad);
    const totBruto = meses.reduce((a,m)=>a+(m.bruto||0),0);
    const totSug   = meses.reduce((a,m)=>a+(m.tributoSugerido||0),0);
    const pctEfectivo = totBruto>0 ? (totSug/totBruto*100) : 0;
    renderMVarRecos({
      promedio:promedio, mediana:mediana,
      ingresoBaseSeguro:ingresoBaseSeguro, ingresoPesimista:ingresoPesimista,
      variabilidad:variabilidad, tendencia:tendencia,
      salario:salarioActual, fondo:v.fondoActual,
      tributoPct:pctEfectivo, mesesCount:meses.length,
      cobertura:cobertura, meses:meses
    });
  }
  
  function renderMVarTributario(meses){
    const card = document.getElementById('mvar-tributario-card');
    if(!meses.length){card.style.display='none';return;}
    card.style.display='block';
  
    let totalBruto=0, totalDebido=0, totalReservado=0;
    let mesesSinReserva=0, mesesInsuficiente=0, mesesOk=0;
    meses.forEach(function(m){
      const reserva = m.tributo || 0;
      const debido = m.tributoSugerido || 0;
      totalBruto      += m.bruto || 0;
      totalDebido     += debido;
      totalReservado  += reserva;
      if(m.bruto>0){
        if(reserva===0) mesesSinReserva++;
        else if(reserva < debido) mesesInsuficiente++;
        else mesesOk++;
      }
    });
    const deficit = Math.max(0, totalDebido - totalReservado);
    const cobertura = totalDebido>0 ? totalReservado/totalDebido : 0;
  
    let estadoClass='is-pos', estadoLabel='Al día';
    if(deficit>0 && cobertura<0.5){estadoClass='is-neg';estadoLabel='Déficit alto';}
    else if(deficit>0){estadoClass='is-warn';estadoLabel='Déficit parcial';}
  
    let html = '<div class="tributario-grid">'
      + '<div class="tributario-stat"><div class="tributario-label">Ingreso bruto del periodo</div><div class="tributario-value">' + fmt(totalBruto) + '</div><div class="tributario-sub">' + meses.length + ' meses · todo lo facturado</div></div>'
      + '<div class="tributario-stat"><div class="tributario-label">Lo que debiste apartar</div><div class="tributario-value">' + fmt(totalDebido) + '</div><div class="tributario-sub">según la retención de cada contrato</div></div>'
      + '<div class="tributario-stat ' + estadoClass + '"><div class="tributario-label">Lo que efectivamente apartaste</div><div class="tributario-value">' + fmt(totalReservado) + '</div><div class="tributario-sub">' + pct(cobertura) + ' de lo debido · ' + estadoLabel + '</div></div>'
      + '</div>';
  
    if(deficit>0){
      html += '<div class="tributario-deficit">'
        + '<div class="tributario-deficit-icon">' + SVG_WARN + '</div>'
        + '<div class="tributario-deficit-body">'
        + '<div class="tributario-deficit-label">Déficit tributario acumulado</div>'
        + '<div class="tributario-deficit-value">' + fmt(deficit) + '</div>'
        + '<div class="tributario-deficit-text">En algún momento te tocará pagarlo. Si no lo apartas y te llega la declaración o un cobro, puedes verte obligado a endeudarte para cumplir. La recomendación es empezar a apartar <strong>' + fmt(Math.ceil(deficit/Math.max(meses.length,6))) + '</strong> mensual adicional mientras pones al día tu reserva corriente.</div>'
        + '</div></div>';
    } else {
      html += '<div class="alert pos" style="margin-top:14px">' + SVG_CHECK + '<div><strong>Reserva al día.</strong> Has apartado lo suficiente para cubrir tu deber tributario teórico.</div></div>';
    }
  
    html += '<div class="tributario-breakdown">'
      + '<div class="tb-item ok"><span class="tb-dot"></span><strong>' + mesesOk + '</strong> meses con reserva suficiente</div>'
      + '<div class="tb-item warn"><span class="tb-dot"></span><strong>' + mesesInsuficiente + '</strong> meses con reserva insuficiente</div>'
      + '<div class="tb-item bad"><span class="tb-dot"></span><strong>' + mesesSinReserva + '</strong> meses sin reservar nada</div>'
      + '</div>'
      + '<div style="margin-top:14px"><button class="btn-ghost" id="btn-aplicar-reserva-sug">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9c2.5 0 4.77 1.02 6.4 2.66"/></svg>'
      + 'Aplicar la reserva sugerida de cada contrato a sus meses'
      + '</button></div>';
  
    document.getElementById('mvar-tributario-content').innerHTML = html;
  
    const btn = document.getElementById('btn-aplicar-reserva-sug');
    if(btn){
      btn.onclick = function(){
        showConfirm({
          title:'Aplicar reserva sugerida',
          msg:'Esto sobrescribirá la retención apartada en cada mes con el % de cada contrato (solo donde aplica retención). ¿Continuar?',
          confirmText:'Aplicar',
          onConfirm:function(){
            (state.varIncome.contratos||[]).forEach(function(c){
              if(!c.retencionAplica) return;
              (c.meses||[]).forEach(function(m){
                if(m.bruto > 0) m.tributo = Math.round(m.bruto * (c.retencionPct||0)/100);
              });
            });
            renderMVarContratos();
            renderMVarStats();
            propagateMVarChanges();
            showToast('Reservas actualizadas','success');
          }
        });
      };
    }
  }
  
  function renderMVarChart(meses, netos, salario){
    const ctx = document.getElementById('mvar-chart').getContext('2d');
    if(chartMVar){chartMVar.destroy();chartMVar=null;}
    if(!meses.length) return;
  
    const labels = meses.map(m => m.label || '—');
    const colors = netos.map(v => v>=salario ? '#0e4d3a' : '#8a1f1c');
  
    chartMVar = new Chart(ctx, {
      data: {
        labels:labels,
        datasets: [
          {type:'bar',label:'Ingreso neto',data:netos,
            backgroundColor:colors.map(c=>c+'cc'),borderColor:colors,
            borderWidth:0,borderRadius:6,maxBarThickness:36},
          {type:'line',label:'Salario personal',data:netos.map(()=>salario),
            borderColor:'#0c0c0d',borderWidth:2,borderDash:[6,4],
            pointRadius:0,fill:false,tension:0}
        ]
      },
      options:{
        responsive:true,maintainAspectRatio:false,
        plugins:{
          legend:{display:false},
          tooltip:{
            backgroundColor:'#0c0c0d',titleColor:'#fff',bodyColor:'#fff',
            padding:12,cornerRadius:10,
            titleFont:{family:'Geist',weight:'600',size:12},
            bodyFont:{family:'JetBrains Mono',size:12},
            callbacks:{label:function(ctx){return ' '+ctx.dataset.label+': '+fmt(ctx.parsed.y);}}
          }
        },
        scales:{
          x:{ticks:{color:'#6f6e6a',font:{family:'Geist',size:11}},grid:{display:false},border:{color:'#e6dfd0'}},
          y:{ticks:{color:'#6f6e6a',font:{family:'JetBrains Mono',size:10.5},
              callback:function(v){return v>=1000000 ? (v/1000000).toFixed(1)+'M' : v>=1000 ? (v/1000).toFixed(0)+'k' : v;}},
            grid:{color:'#efe9da',drawBorder:false},border:{display:false}}
        }
      }
    });
  }
  
  function renderMVarFondo(salario, variabilidad){
    const v = state.varIncome;
    const meta = getFondoMetaActual();             // z·σ·√L
    const actual = v.fondoActual || 0;
    const pctMeta = meta>0 ? Math.min(actual/meta, 1) : 0;

    document.getElementById('fondo-actual-val').textContent = fmt(actual);
    document.getElementById('fondo-meta-val').textContent = meta>0 ? fmt(meta) : '—';
    document.getElementById('fondo-meta-sub').textContent = meta>0
      ? 'Colchón para suavizar tu variabilidad (' + pct(variabilidad) + ') · fórmula 1,65·σ·√6'
      : 'Necesitas al menos 3 meses de historial';
    document.getElementById('fondo-cobertura-val').textContent = meta>0 ? pct(pctMeta) : '—';
    document.getElementById('fondo-progress').style.width = (pctMeta*100) + '%';
    document.getElementById('fondo-progress-meta').innerHTML = '<span>' + fmt(actual) + '</span><span>' + pct(pctMeta) + ' de la meta · ' + fmt(meta) + '</span>';

    const alertEl = document.getElementById('fondo-alert');
    if(meta<=0){
      alertEl.style.display = 'none';
    } else if(pctMeta < 0.5){
      alertEl.className = 'alert neg';alertEl.style.display = 'flex';
      alertEl.innerHTML = SVG_WARN + '<div><strong>Prioridad.</strong> Tu fondo cubre menos de la mitad del colchón que necesitas para suavizar tus meses flojos. Te faltan <strong>' + fmt(meta-actual) + '</strong>.</div>';
    } else if(pctMeta < 1){
      alertEl.className = 'alert warn';alertEl.style.display = 'flex';
      alertEl.innerHTML = SVG_INFO + '<div>Vas bien. Te faltan <strong>' + fmt(meta-actual) + '</strong> para completar tu colchón de estabilización.</div>';
    } else {
      alertEl.className = 'alert pos';alertEl.style.display = 'flex';
      alertEl.innerHTML = SVG_CHECK + '<div><strong>Colchón completo.</strong> Tienes lo necesario para suavizar la variabilidad de tu ingreso. Cubrir la pérdida de un contrato es tarea del <strong>fondo de emergencia</strong>, que es una meta aparte.</div>';
    }
  }
  
  function renderMVarRecos(s){
    const recos = [];
  
    if(s.variabilidad >= 0.5){
      recos.push({type:'warn',title:'Tu ingreso es muy volátil',
        text:'Tu ingreso varía un ' + pct(s.variabilidad) + ' mes a mes en promedio. Eso significa que cualquier mes puede alejarse mucho de lo típico. <strong>Necesitas un fondo de 9 a 12 meses</strong> de salario, no los 6 estándar. Considera diversificar tu ingreso (más clientes pequeños en lugar de uno grande) para reducir la volatilidad estructural.'});
    } else if(s.variabilidad >= 0.25){
      recos.push({type:'info',title:'Tu ingreso varía dentro de un rango esperable',
        text:'Tu ingreso varía un ' + pct(s.variabilidad) + ' mes a mes. Un fondo de 6 a 9 meses es razonable para tu caso. Lo más importante: nunca subas tu salario personal en un mes bueno. La disciplina del salario fijo es lo que te protege.'});
    } else {
      recos.push({type:'pos',title:'Tu ingreso es relativamente estable',
        text:'Tu ingreso solo varía un ' + pct(s.variabilidad) + ' mes a mes, lo que indica un negocio bastante predecible. Puedes operar con 6 meses de fondo y enfocar más recursos a inversión y construcción de patrimonio.'});
    }
  
    if(s.tendencia < -0.1){
      recos.push({type:'neg',title:'Tu ingreso viene bajando · revisar precios y clientes',
        text:'En los últimos meses tu ingreso viene en descenso. No esperes a que sea crítico. Antes de ajustar tu salario hacia abajo, pregúntate: ¿es algo estacional o estructural? Si llevas 4 meses o más bajando, considera revisar tarifas, dejar clientes que no pagan bien, o agregar líneas de servicio.'});
    } else if(s.tendencia > 0.15){
      recos.push({type:'pos',title:'Tu ingreso viene subiendo · momento de fortalecer reservas',
        text:'Tu ingreso viene creciendo. <strong>No subas el salario personal todavía</strong>. Mantenlo igual por al menos 6 meses más, y dirige el excedente a llenar el fondo y a inversión. El error típico del independiente es subir el estilo de vida apenas mejora el negocio.'});
    }
  
    if(s.meses && s.meses.length){
      let totalDebido=0, totalReservado=0, mesesSinReserva=0;
      s.meses.forEach(function(m){
        totalDebido    += m.tributoSugerido || 0;
        totalReservado += m.tributo || 0;
        if(m.bruto>0 && (m.tributo||0)===0) mesesSinReserva++;
      });
      const deficit = Math.max(0, totalDebido - totalReservado);
      const cob = totalDebido>0 ? totalReservado/totalDebido : 1;
  
      if(deficit > 0 && cob < 0.5){
        recos.push({type:'neg',title:'Tienes un déficit tributario importante',
          text:'Has apartado solo ' + pct(cob) + ' de lo que deberías para impuestos. Eso es una <strong>deuda silenciosa de ' + fmt(deficit) + '</strong> con la DIAN que en algún momento te toca pagar. Lo más urgente: empieza a apartar el ' + s.tributoPct + '% sugerido de cada nuevo ingreso, y aparta extra mensualmente para cerrar el atraso. Si la declaración te llega y no tienes la plata, terminas endeudándote a tasa cara para cumplirle al Estado.'});
      } else if(deficit > 0){
        recos.push({type:'warn',title:'Reserva tributaria parcial',
          text:'Has apartado ' + pct(cob) + ' de lo que deberías. Te falta <strong>' + fmt(deficit) + '</strong> para estar al día. Empieza a apartar la diferencia mensualmente; mejor tener tributo de más que de menos.'});
      } else if(mesesSinReserva > s.meses.length/3){
        recos.push({type:'warn',title:'Hay meses sin reserva tributaria',
          text:'En ' + mesesSinReserva + ' de tus ' + s.meses.length + ' meses no apartaste nada para impuestos. Aunque al final del periodo el total cuadra, la disciplina importa: aparta el porcentaje sugerido de <em>cada</em> ingreso, idealmente a una cuenta separada que no toques.'});
      }
    }
  
    if(s.tributoPct > 0 && s.tributoPct < 8){
      recos.push({type:'warn',title:'Tu porcentaje de reserva está bajo',
        text:'Configuraste solo ' + s.tributoPct + '% de reserva tributaria. Para un independiente en régimen ordinario en Colombia, esto suele ser insuficiente. <strong>Sugerido: 10 % a 15 %</strong>. Si te llega una declaración alta sin reserva, terminas pagando con deuda.'});
    }
  
    if(s.fondo < s.salario){
      recos.push({type:'neg',title:'Construir el fondo es la prioridad número uno',
        text:'Sin fondo, un mes malo te obliga a endeudarte o recortar gastos básicos. <strong>Antes de ahorrar para retiro, antes de invertir, antes de pagar deuda no urgente</strong>: junta al menos un mes de salario. Es la decisión financiera de mayor impacto en tu calidad de vida.'});
    } else if(s.fondo < s.salario*3){
      recos.push({type:'info',title:'Continúa la acumulación del fondo',
        text:'Tienes una base. La siguiente meta es <strong>3 meses de salario</strong>. En este punto puedes empezar a destinar una parte pequeña (10 a 20 % del excedente) a otras prioridades como deuda cara, sin descuidar el fondo.'});
    }
  
    if(s.cobertura < 0.6 && s.mesesCount >= 6){
      recos.push({type:'warn',title:'Tu salario personal es muy alto frente al historial',
        text:'Solo el ' + pct(s.cobertura) + ' de tus meses históricos soportan el salario que te asignaste. Eso significa que casi la mitad del tiempo el fondo está drenándose. <strong>Considera bajar el salario al ingreso base seguro sugerido</strong> y redirigir el excedente al fondo. Mejor un sueldo modesto sostenible que uno alto que te genere ansiedad.'});
    }
  
    if(!recos.length){
      recos.push({type:'pos',title:'Buena posición financiera',text:'Tus indicadores principales están en rangos saludables para un independiente. Sigue ejecutando la disciplina del salario fijo y el fondo de estabilización.'});
    }
  
    document.getElementById('mvar-recos').innerHTML = recos.map(function(r){
      const icon = r.type==='neg'?SVG_WARN:r.type==='warn'?SVG_WARN:r.type==='pos'?SVG_CHECK:SVG_INFO;
      return '<div class="reco-item"><div class="reco-icon ' + r.type + '">' + icon + '</div>'
        + '<div class="reco-body"><div class="reco-title">' + r.title + '</div>'
        + '<div class="reco-text">' + r.text + '</div></div></div>';
    }).join('');
  }
  
  /* Propagación cruzada */
  function propagateMVarChanges(){
    renderIngresosTable();calcM1();
    renderActivosTable();calcM3();
    renderAhorroTable();calcM4();
    scheduleSave('ingresos_variables');
  }
  
  /* Event handlers MVar */
  document.getElementById('mvar-active').addEventListener('change', function(){
    state.varIncome.active = this.checked;
    renderMVar();
    propagateMVarChanges();
  });
  document.getElementById('mvar-add-contrato').addEventListener('click', function(){
    if(state.varIncome.contratos.length >= 8){showToast('Máximo 8 contratos','error');return;}
    state.varIncome.contratos.push(nuevoContrato());
    renderMVarContratos();renderMVarStats();
    scheduleSave('ingresos_variables');
  });
  document.getElementById('mvar-fondo-actual').addEventListener('input', function(){
    state.varIncome.fondoActual = n(this.value);
    renderMVarStats();propagateMVarChanges();
  });
  document.getElementById('mvar-salary-input').addEventListener('input', function(){
    const val = n(this.value);
    state.varIncome.salarioPersonal = val;
    state.varIncome.salarioOverride = val>0;
    renderMVarStats();propagateMVarChanges();
  });
  document.getElementById('mvar-salary-reset').addEventListener('click', function(){
    state.varIncome.salarioOverride = false;
    state.varIncome.salarioPersonal = 0;
    renderMVarStats();propagateMVarChanges();
  });
  
  async function saveMVar(){
    await saveModule('ingresos_variables', state.varIncome);
    completedModules.add('var');updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tu análisis de ingresos variables se guardó correctamente.');
    showToast('Guardado','success');
  }
  /* save-mvar eliminado: autoguardado en tiempo real */
  
  /* DEMO DATA — Carlos Mendoza */
  function loadDemoIndependent(){
    state.profile.tipoIngreso = 'independiente';
    const contrato = nuevoContrato();
    contrato.nombre = 'Comisiones de seguros';
    contrato.tipo = 'comisiones';
    contrato.retencionAplica = true;
    contrato.retencionPct = 11;
    state.varIncome = {
      active:true, contratos:[contrato],
      fondoActual:8500000, salarioPersonal:0, salarioOverride:false
    };
    const today = new Date();
    const dataReal = [
      {bruto:5200000, costos:380000, tributo:572000},
      {bruto:8400000, costos:520000, tributo:924000},
      {bruto:6900000, costos:410000, tributo:500000},
      {bruto:4800000, costos:350000, tributo:0},
      {bruto:9200000, costos:580000, tributo:600000},
      {bruto:7100000, costos:440000, tributo:0},
      {bruto:5800000, costos:390000, tributo:0},
      {bruto:8800000, costos:510000, tributo:800000},
      {bruto:6400000, costos:420000, tributo:700000},
      {bruto:7800000, costos:470000, tributo:858000},
      {bruto:11200000,costos:680000, tributo:1232000},
      {bruto:4200000, costos:340000, tributo:0}
    ];
    for(let i=0;i<12;i++){
      const d = new Date(today.getFullYear(), today.getMonth()-12+i, 1);
      const item = dataReal[i];
      const mes = {
        label:MES_NAMES_ES[d.getMonth()]+' '+d.getFullYear(),
        bruto:item.bruto, costos:item.costos, tributo:item.tributo,
        neto:0, monthIdx:d.getMonth(), anio:d.getFullYear()
      };
      recalcMesNetoC(contrato, mes);
      contrato.meses.push(mes);
    }
  
    state.ingresos = [
      {nombre:'Renovaciones (recurrente)', monto:1200000},
      {nombre:'Bonos de aseguradoras', monto:500000}
    ];
    state.gastos = {
      alimentacion:1800000, vivienda:2400000, transporte:950000,
      salud:680000, entretenimiento:450000, comunicaciones:220000, otros:380000
    };
    state.gastosItems = {};
    state.deudas = [
      {nombre:'Tarjeta Bancolombia', saldo:8500000, cuota_mensual:850000, tasa_anual:0.288, tipo:'CONSUMO_TARJETA', grupo:'consumo'},
      {nombre:'Crédito vehicular Davivienda', saldo:32000000, cuota_mensual:980000, tasa_anual:0.158, tipo:'OTRO_VEHICULO', grupo:'otro'}
    ];
    state.activos = [
      {nombre:'Cuenta de ahorros Bancolombia', valor:4200000, tipo:'LÍQUIDO'},
      {nombre:'CDT a 6 meses', valor:6000000, tipo:'LÍQUIDO'},
      {nombre:'Apartamento (cuota inicial pagada)', valor:95000000, tipo:'NO LÍQUIDO'},
      {nombre:'Vehículo Mazda CX-5', valor:78000000, tipo:'NO LÍQUIDO'},
      {nombre:'Pensión voluntaria Skandia', valor:12500000, tipo:'NO LÍQUIDO', restringido:true}
    ];
    state.ahorro = [
      {nombre:'Fondo de emergencias', monto_mensual:400000},
      {nombre:'Pensión voluntaria', monto_mensual:600000},
      {nombre:'Educación de los hijos', monto_mensual:350000},
      {nombre:'Vacaciones familiares', monto_mensual:200000}
    ];
  
    // M5 — presupuesto anual de Carlos con calendario lleno
    state.p5 = {
      socio1:'Carlos', socio2:'Andrea',
      fondoProvisiones: 3200000, // tiene parte provisionado, no todo
      ingresos: [
        {nombre:'Devolución de retención en la fuente', frec:'NO ES TODOS LOS MESES', mes:'09', monto:1800000, pertenece:'socio1', obs:''},
        {nombre:'Dividendos de mi empresa', frec:'NO ES TODOS LOS MESES', mes:'04', monto:4500000, pertenece:'socio1', obs:'Reparto anual de utilidades'},
        {nombre:'Honorarios extraordinarios o bonos', frec:'NO ES TODOS LOS MESES', mes:'', monto:0, pertenece:'', obs:''}
      ],
      deudas:[],
      ahorro:[],
      gastos:{
        vivienda:[
          {nombre:'Predial', frec:'NO ES TODOS LOS MESES', mes:'02', monto:1850000, pertenece:'ambos', obs:'Apartamento El Poblado'}
        ],
        transporte:[
          {nombre:'Impuesto del vehículo', frec:'NO ES TODOS LOS MESES', mes:'05', monto:1450000, pertenece:'socio1', obs:''}
        ],
        educacion:[
          {nombre:'Matrícula del colegio', frec:'NO ES TODOS LOS MESES', mes:'01', monto:4200000, pertenece:'ambos', obs:'2 hijos · Colegio Marymount'},
          {nombre:'Útiles y uniformes', frec:'NO ES TODOS LOS MESES', mes:'01', monto:1100000, pertenece:'ambos', obs:''}
        ],
        seguros:[
          {nombre:'Póliza de vida', frec:'NO ES TODOS LOS MESES', mes:'06', monto:2400000, compania:'Sura', pertenece:'socio1', obs:'Vence jun · cliente desde 2018'},
          {nombre:'Póliza de auto', frec:'NO ES TODOS LOS MESES', mes:'08', monto:4200000, compania:'Bolívar', pertenece:'socio1', obs:'Todo riesgo · Mazda CX-5 · vence 15 ago'},
          {nombre:'Seguro de hogar', frec:'NO ES TODOS LOS MESES', mes:'11', monto:1100000, compania:'Mapfre', pertenece:'ambos', obs:''},
          {nombre:'Medicina prepagada anual', frec:'NO ES TODOS LOS MESES', mes:'03', monto:6800000, compania:'Sura', pertenece:'ambos', obs:'4 personas en póliza'},
          {nombre:'Regalos y fechas especiales', frec:'NO ES TODOS LOS MESES', mes:'12', monto:2200000, pertenece:'ambos', obs:''}
        ]
      }
    };
  
    renderIngresosTable();
    renderGastosTable('gastos-body');
    calcM1();
    renderDeudasTable();calcM2();
    renderActivosTable();calcM3();
    renderAhorroTable();calcM4();
    initP5();calcP5Totals();
  
    // Marcar select de tipo en M1
    const tipoSel = document.getElementById('tipo-ingreso');
    if(tipoSel) tipoSel.value = 'independiente';
  
    completedModules.add(1);completedModules.add(2);
    completedModules.add(3);completedModules.add(4);completedModules.add(5);
    completedModules.add('var');
    updateProgress();updateNavStatus();
    showToast('Datos demo cargados · Carlos Mendoza (independiente)','success');
    setTimeout(function(){navigateTo('var');}, 600);
  }
  
  function loadDemoEmpleada(){
    state.profile.tipoIngreso = 'empleado';
    state.varIncome = {
      active:false, contratos:[],
      fondoActual:0, salarioPersonal:0, salarioOverride:false
    };
  
    // María, 34 años, Coordinadora de marketing en una multinacional
    state.ingresos = [
      {nombre:'Salario neto mensual', monto:5800000},
      {nombre:'Auxilio de movilización', monto:280000}
    ];
    state.gastos = {
      alimentacion:1450000, vivienda:1800000, transporte:550000,
      salud:280000, entretenimiento:380000, comunicaciones:180000, otros:240000
    };
    state.gastosItems = {};
    state.deudas = [
      {nombre:'Tarjeta Davivienda', saldo:4200000, cuota_mensual:520000, tasa_anual:0.305, tipo:'CONSUMO_TARJETA', grupo:'consumo'},
      {nombre:'Libranza educativa', saldo:12500000, cuota_mensual:380000, tasa_anual:0.165, tipo:'LIBRANZA', grupo:'consumo'}
    ];
    state.activos = [
      {nombre:'Cuenta de ahorros Bancolombia', valor:2800000, tipo:'LÍQUIDO'},
      {nombre:'Fondo voluntario Protección', valor:18500000, tipo:'NO LÍQUIDO', restringido:true},
      {nombre:'Cesantías acumuladas', valor:6200000, tipo:'NO LÍQUIDO', restringido:true},
      {nombre:'Apartamento (heredado, sin hipoteca)', valor:185000000, tipo:'NO LÍQUIDO'}
    ];
    state.ahorro = [
      {nombre:'Fondo de emergencias', monto_mensual:300000},
      {nombre:'Pensión voluntaria (Skandia)', monto_mensual:450000},
      {nombre:'Vacaciones', monto_mensual:200000}
    ];
  
    // M5 — presupuesto anual de María con primas legales y pólizas
    state.p5 = {
      socio1:'María', socio2:'',
      fondoProvisiones: 1500000,
      ingresos: [
        {nombre:'Prima legal de mitad de año', frec:'NO ES TODOS LOS MESES', mes:'06', monto:3050000, pertenece:'socio1', obs:'Salario integral / 2'},
        {nombre:'Prima legal de fin de año', frec:'NO ES TODOS LOS MESES', mes:'12', monto:3050000, pertenece:'socio1', obs:''},
        {nombre:'Cesantías (consignación a fondo)', frec:'NO ES TODOS LOS MESES', mes:'02', monto:6100000, pertenece:'socio1', obs:'Para imprevistos o estudio'},
        {nombre:'Bonificación / participación de utilidades', frec:'NO ES TODOS LOS MESES', mes:'04', monto:2200000, pertenece:'socio1', obs:'Variable según resultados'},
        {nombre:'Devolución de retención en la fuente', frec:'NO ES TODOS LOS MESES', mes:'09', monto:1400000, pertenece:'socio1', obs:''}
      ],
      deudas:[],
      ahorro:[],
      gastos:{
        vivienda:[
          {nombre:'Predial', frec:'NO ES TODOS LOS MESES', mes:'02', monto:1240000, pertenece:'socio1', obs:'Apartamento heredado'}
        ],
        transporte:[
          {nombre:'Impuesto del vehículo', frec:'NO ES TODOS LOS MESES', mes:'05', monto:480000, pertenece:'socio1', obs:''}
        ],
        educacion:[],
        seguros:[
          {nombre:'Póliza de vida', frec:'NO ES TODOS LOS MESES', mes:'07', monto:1200000, compania:'Bolívar', pertenece:'socio1', obs:'Tomada por la empresa, María paga complemento'},
          {nombre:'Póliza de auto', frec:'NO ES TODOS LOS MESES', mes:'10', monto:2400000, compania:'Allianz', pertenece:'socio1', obs:'Todo riesgo · sedán pequeño'},
          {nombre:'Medicina prepagada anual', frec:'NO ES TODOS LOS MESES', mes:'03', monto:2800000, compania:'Colsanitas', pertenece:'socio1', obs:''},
          {nombre:'Regalos y fechas especiales', frec:'NO ES TODOS LOS MESES', mes:'12', monto:1500000, pertenece:'socio1', obs:''}
        ]
      }
    };
  
    renderIngresosTable();
    renderGastosTable('gastos-body');
    calcM1();
    renderDeudasTable();calcM2();
    renderActivosTable();calcM3();
    renderAhorroTable();calcM4();
    initP5();calcP5Totals();
  
    const tipoSel = document.getElementById('tipo-ingreso');
    if(tipoSel) tipoSel.value = 'empleado';
  
    completedModules.add(1);completedModules.add(2);
    completedModules.add(3);completedModules.add(4);completedModules.add(5);
    updateProgress();updateNavStatus();
    showToast('Datos demo cargados · María Restrepo (empleada)','success');
    setTimeout(function(){navigateTo(5);}, 600);
  }
  
  /* Los perfiles demo visibles en el inicio se eliminaron. El acceso demo por URL (?demo=carlos|maria) se conserva solo para pruebas internas. */

  (function autoDemo(){
    const params = new URLSearchParams(window.location.search);
    const which = params.get('demo');
    if(which==='1' || which==='carlos'){
      setTimeout(function(){
        userId = 'demo_carlos';
        currency = 'COP $';
        document.getElementById('user-display').textContent = 'Carlos Mendoza';
        document.getElementById('user-avatar').textContent = 'C';
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').classList.add('show');
        loadDemoIndependent();
      }, 100);
    } else if(which==='maria'){
      setTimeout(function(){
        userId = 'demo_maria';
        currency = 'COP $';
        document.getElementById('user-display').textContent = 'María Restrepo';
        document.getElementById('user-avatar').textContent = 'M';
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').classList.add('show');
        loadDemoEmpleada();
      }, 100);
    }
  })();
  
  /* ═══════════════════════════════════════════════════════════
     SISTEMA DE DEFINICIONES (tooltips informativos)
     ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     MÓDULO 10 · PERFIL FISCAL
     ═══════════════════════════════════════════════════════════ */
  function factorArt73(anio, tipo){
    if(!tipo) return 1;   // activos sin ajuste del art. 73 (vehículos, cripto, oro, arte, ETF, FIC, REIT, cartera)
    const tab = ((fiscalConfig().gananciaOcasional||{}).factoresArt73||{})[tipo] || {};
    const ys = Object.keys(tab).map(Number).filter(y=>!isNaN(y)).sort((a,b)=>a-b);
    if(!ys.length) return 1;
    if(anio <= ys[0]) return tab[ys[0]];
    if(anio >= ys[ys.length-1]) return tab[ys[ys.length-1]];
    if(tab[anio] != null) return tab[anio];
    // Año intermedio sin valor exacto: interpolar entre el inferior y el superior más cercanos
    let lo = ys[0], hi = ys[ys.length-1];
    for(const y of ys){ if(y<=anio) lo=y; if(y>=anio){ hi=y; break; } }
    if(hi===lo) return tab[lo];
    return +(tab[lo] + (tab[hi]-tab[lo])*((anio-lo)/(hi-lo))).toFixed(4);
  }
  // Clasifica el activo para el art. 73: solo bienes raíces y acciones/aportes tienen ajuste.
  function tipoArt73(a){
    if(!a) return null;
    if(a.category === 'Inmueble') return 'bienRaizUrbano';
    if(a.category === 'Empresarial') return 'acciones';
    if(a.category === 'Financiero' && a.subtype === 'Acciones en bolsa') return 'acciones';
    return null;   // demás activos: el costo fiscal es el de adquisición, sin ajuste del art. 73
  }
  function calcCostoFiscal(cf, tipo){
    if(cf.origen === 'heredado'){
      // Costo fiscal de un bien heredado = valor de adjudicación en la sucesión (art. 303/277),
      // ajustable por art. 73 tomando como año de adquisición el de la sucesión.
      return Math.round((cf.valorSucesion||0) * factorArt73(+cf.anioSucesion || new Date().getFullYear(), tipo));
    }
    if(cf.metodo === 'avaluo') return Math.round(cf.avaluo||0);
    return Math.round((cf.valorCompra||0) * factorArt73(+cf.anioCompra || new Date().getFullYear(), tipo));
  }
  // Subtipos financieros que SÍ generan ganancia ocasional al venderse (inversiones de capital).
  // Se excluyen efectivo, cuentas, CDT, bonos, AFC, FPV, fiducias y cuentas por cobrar (su rendimiento es interés = renta de capital, no ganancia ocasional).
  const PF_FIN_GANANCIA = ['Acciones en bolsa','ETF o fondo de inversión internacional','Fondo de inversión colectiva FIC','REIT','Cartera gestionada por terceros'];
  // Parte del activo que le corresponde al usuario (activos compartidos). 1 = 100% suyo.
  function mpShare(a){ const p=(a && a.porcentajePropio!=null && a.porcentajePropio>0 && a.porcentajePropio<=100) ? a.porcentajePropio : 100; return p/100; }
  function pfAssetsVendibles(){
    const acts = (state.mapaPatrimonial && state.mapaPatrimonial.activos) || [];
    return acts.filter(a=>{
      if(!a || !(a.value>0)) return false;
      // Solo "Financiero" se filtra por subtipo; las demás categorías (Inmueble, Empresarial,
      // Alternativo, Uso Personal) son activos fijos cuya venta genera ganancia ocasional.
      if(a.category === 'Financiero') return PF_FIN_GANANCIA.includes(a.subtype);
      return true;
    });
  }

  function pfActualizarExtNota(){
    const el = document.getElementById('pf-extNota'); if(!el) return;
    const f = state.fiscal;
    if(!f.exterior.tiene){ el.textContent=''; return; }
    const tope = enPesos((fiscalConfig().activosExterior||{}).topeUVT || 2000);
    if((f.exterior.valor||0) > tope){
      el.innerHTML = '⚠ Tus activos en el exterior ('+fmt(f.exterior.valor)+') superan el tope de '+fmt(tope)+' (2.000 UVT): debes presentar la declaración de activos en el exterior.';
      el.className = 'pf-note pf-warn';
    } else {
      el.innerHTML = 'Por ahora estás por debajo del tope de '+fmt(tope)+' (2.000 UVT) para declarar activos en el exterior.';
      el.className = 'pf-note';
    }
  }

  function renderPfActivos(){
    const cont = document.getElementById('pf-activos'); if(!cont) return;
    const f = state.fiscal;
    const acts = pfAssetsVendibles();
    cont.innerHTML = '';
    if(!acts.length){
      cont.innerHTML = '<div class="pf-empty">Aún no has registrado activos que puedan venderse (inmuebles, vehículos, inversiones) en tu Mapa Patrimonial. Cuando los registres, aquí calcularemos su costo fiscal.</div>';
      return;
    }
    const nota = document.createElement('div');
    nota.className = 'pf-note';
    nota.style.marginBottom = '6px';
    nota.innerHTML = 'Esto es una <strong>estimación</strong> para planear. El factor del art. 73 lo fija un decreto de la DIAN según el <strong>año de venta</strong>; al vender, tu contador escoge el método que más te convenga (art. 70, 72 o 73) y aplica las exenciones del caso (vivienda, acciones en bolsa, etc.).';
    cont.appendChild(nota);
    const anioActual = new Date().getFullYear();
    acts.forEach(a=>{
      const cf = f.costoFiscal[a.id] || {origen:'comprado', metodo:'precio', anioCompra:'', valorCompra:0, avaluo:0, valorSucesion:0, anioSucesion:'', ventaEstimada:0};
      if(!cf.origen) cf.origen = 'comprado';
      f.costoFiscal[a.id] = cf;
      const tipo = tipoArt73(a);
      const esInmueble = a.category === 'Inmueble';
      const esVivienda = a.subtype === 'Casa o apartamento donde vivo';
      const card = document.createElement('div');
      card.className = 'pf-asset';
      let opts=''; for(let y=anioActual; y>=1990; y--){ opts += '<option value="'+y+'"'+(String(cf.anioCompra)===String(y)?' selected':'')+'>'+y+'</option>'; }
      let optsSuc=''; for(let y=anioActual; y>=1990; y--){ optsSuc += '<option value="'+y+'"'+(String(cf.anioSucesion)===String(y)?' selected':'')+'>'+y+'</option>'; }
      card.innerHTML =
        '<div class="pf-asset-top"><span class="pf-asset-name">'+(a.description||a.subtype||'Activo')+'</span><span class="pf-asset-val">Valor hoy: '+fmt(Math.round((a.value||0)*mpShare(a)))+(mpShare(a)<1?' <span class="pf-mut">(tu '+a.porcentajePropio+'%)</span>':'')+'</span></div>'
        + '<div class="pf-seg pf-seg-sm" data-origen>'
        +   '<button data-o="comprado"'+(cf.origen!=='heredado'?' class="active"':'')+'>Comprado</button>'
        +   '<button data-o="heredado"'+(cf.origen==='heredado'?' class="active"':'')+'>Heredado o donado</button>'
        + '</div>'
        + '<div class="pf-comprado" '+(cf.origen==='heredado'?'style="display:none"':'')+'>'
        +   '<div class="pf-seg pf-seg-sm" data-met>'
        +     '<button data-m="precio"'+(cf.metodo!=='avaluo'?' class="active"':'')+'>Año y valor de compra</button>'
        +     (esInmueble ? '<button data-m="avaluo"'+(cf.metodo==='avaluo'?' class="active"':'')+'>Avalúo catastral</button>' : '')
        +   '</div>'
        +   '<div class="pf-met-precio" '+(cf.metodo==='avaluo'?'style="display:none"':'')+'>'
        +     '<div class="pf-grid2">'
        +       '<div class="pf-field"><label>Año de compra</label><div class="pf-inp"><select data-cf="anioCompra">'+opts+'</select></div></div>'
        +       '<div class="pf-field"><label>Valor de compra</label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" data-cf="valorCompra" inputmode="numeric"></div></div>'
        +     '</div>'
        +   '</div>'
        +   '<div class="pf-met-avaluo" '+(cf.metodo!=='avaluo'?'style="display:none"':'')+'>'
        +     '<div class="pf-field"><label>Avalúo catastral <span class="info-tip" data-def="avaluo_catastral" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" data-cf="avaluo" inputmode="numeric"></div></div>'
        +   '</div>'
        + '</div>'
        + '<div class="pf-heredado" '+(cf.origen!=='heredado'?'style="display:none"':'')+'>'
        +   '<div class="pf-grid2">'
        +     '<div class="pf-field"><label>Año de la sucesión</label><div class="pf-inp"><select data-cf="anioSucesion">'+optsSuc+'</select></div></div>'
        +     '<div class="pf-field"><label>Valor de adjudicación <span class="info-tip" data-def="costo_heredado" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" data-cf="valorSucesion" inputmode="numeric"></div></div>'
        +   '</div>'
        +   '<div class="pf-cf-prev" style="margin-top:7px">Es el valor con el que el bien te fue adjudicado en la sucesión. Si no lo tienes, usa el <strong>avalúo catastral</strong> del año en que lo heredaste.</div>'
        + '</div>'
        + '<div class="pf-cf-out"><span class="l">Costo fiscal estimado <em data-cf-metodo></em></span><span class="v" data-cf-val>$0</span></div>'
        + '<div class="pf-field" style="margin-top:12px"><label>Precio de venta estimado <span style="font-weight:400;color:var(--ink-3,#6f6e6a)">(opcional)</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" data-cf="ventaEstimada" inputmode="numeric" placeholder="para estimar el impuesto"></div></div>'
        + '<div class="pf-cf-prev" data-cf-prev></div>';
      cont.appendChild(card);
      // valores iniciales
      const valInp = card.querySelector('[data-cf=valorCompra]'); if(valInp) valInp.value = cf.valorCompra>0?fmtInput(cf.valorCompra):'';
      const avaInp = card.querySelector('[data-cf=avaluo]'); if(avaInp) avaInp.value = cf.avaluo>0?fmtInput(cf.avaluo):'';
      const sucInp = card.querySelector('[data-cf=valorSucesion]'); if(sucInp) sucInp.value = cf.valorSucesion>0?fmtInput(cf.valorSucesion):'';
      if(valInp) attachMoneyInput(valInp);
      if(avaInp) attachMoneyInput(avaInp);
      if(sucInp) attachMoneyInput(sucInp);
      const ventaInp = card.querySelector('[data-cf=ventaEstimada]'); if(ventaInp){ ventaInp.value = cf.ventaEstimada>0?fmtInput(cf.ventaEstimada):''; attachMoneyInput(ventaInp); }

      const refrescar=()=>{
        cf.costoFiscal = calcCostoFiscal(cf, tipo);
        card.querySelector('[data-cf-val]').textContent = fmt(cf.costoFiscal);
        let metodoTxt;
        if(cf.origen==='heredado') metodoTxt = tipo ? '· valor de sucesión, ajustado art. 73' : '· valor de sucesión';
        else if(cf.metodo==='avaluo') metodoTxt = '· avalúo (art. 72)';
        else metodoTxt = tipo ? '· precio ajustado (art. 73)' : '· costo de adquisición';
        card.querySelector('[data-cf-metodo]').textContent = metodoTxt;
        const prev = card.querySelector('[data-cf-prev]');
        if(cf.costoFiscal<=0){ prev.innerHTML=''; scheduleSave('fiscal'); return; }
        const tarifa = (fiscalConfig().gananciaOcasional||{}).tarifa || 0.15;
        const anioAdq = +(cf.origen==='heredado' ? cf.anioSucesion : cf.anioCompra) || 0;
        const aniosTenidos = anioAdq ? (anioActual - anioAdq) : null;
        const usaEjemplo = !(cf.ventaEstimada>0);
        const venta = usaEjemplo ? Math.max(cf.costoFiscal, Math.round(cf.costoFiscal*1.25)) : cf.ventaEstimada;
        const ganancia = Math.max(0, venta - cf.costoFiscal);
        let html = (usaEjemplo ? 'Ejemplo: si vendieras en <b>'+fmt(venta)+'</b>, ' : 'Con una venta de <b>'+fmt(venta)+'</b>, ')
                 + 'la utilidad sería <b>'+fmt(ganancia)+'</b>. ';
        if(aniosTenidos !== null && aniosTenidos < 2){
          html += '<span style="color:var(--warn,#8a5a14)">A hoy lo tienes hace '+aniosTenidos+' año'+(aniosTenidos===1?'':'s')+': si lo vendes antes de cumplir 2 años, esa utilidad tributa como <strong>renta ordinaria</strong> (tu tarifa marginal, hasta 39%), no como ganancia ocasional del 15%.</span>';
        } else {
          let exenta = 0, notaEx = '';
          if(esVivienda){
            const tope = enPesos(5000);
            exenta = Math.min(ganancia, tope);
            notaEx = ' Por ser tu vivienda de habitación, las primeras 5.000 UVT ('+fmt(tope)+') pueden ir <strong>exentas</strong> si reinviertes todo el dinero en otra vivienda, abonas a tu crédito hipotecario o lo llevas a una cuenta AFC.';
          }
          const gravable = Math.max(0, ganancia - exenta);
          const go = Math.round(gravable * tarifa);
          html += 'Impuesto de ganancia ocasional ≈ <b>'+fmt(go)+'</b> ('+Math.round(tarifa*100)+'%).' + notaEx;
          if(tipo==='acciones' && a.category==='Financiero'){
            html += ' Si son acciones de la Bolsa de Valores de Colombia, la utilidad puede estar <strong>exenta</strong> (regla del 10%).';
          }
        }
        prev.innerHTML = html;
        scheduleSave('fiscal');
      };
      // origen
      card.querySelectorAll('[data-origen] button').forEach(b=>{
        b.addEventListener('click',()=>{
          cf.origen = b.dataset.o;
          card.querySelectorAll('[data-origen] button').forEach(x=>x.classList.remove('active')); b.classList.add('active');
          card.querySelector('.pf-comprado').style.display = cf.origen==='heredado'?'none':'block';
          card.querySelector('.pf-heredado').style.display = cf.origen==='heredado'?'block':'none';
          refrescar();
        });
      });
      // método
      card.querySelectorAll('[data-met] button').forEach(b=>{
        b.addEventListener('click',()=>{
          cf.metodo = b.dataset.m;
          card.querySelectorAll('[data-met] button').forEach(x=>x.classList.remove('active')); b.classList.add('active');
          card.querySelector('.pf-met-precio').style.display = cf.metodo==='avaluo'?'none':'block';
          card.querySelector('.pf-met-avaluo').style.display = cf.metodo==='avaluo'?'block':'none';
          refrescar();
        });
      });
      card.querySelector('[data-cf=anioCompra]').addEventListener('change',function(){ cf.anioCompra=this.value; refrescar(); });
      const sucSel = card.querySelector('[data-cf=anioSucesion]'); if(sucSel) sucSel.addEventListener('change',function(){ cf.anioSucesion=this.value; refrescar(); });
      if(valInp) valInp.addEventListener('input',function(){ cf.valorCompra=n(this.value); refrescar(); });
      if(avaInp) avaInp.addEventListener('input',function(){ cf.avaluo=n(this.value); refrescar(); });
      if(sucInp) sucInp.addEventListener('input',function(){ cf.valorSucesion=n(this.value); refrescar(); });
      if(ventaInp) ventaInp.addEventListener('input',function(){ cf.ventaEstimada=n(this.value); refrescar(); });
      refrescar();
    });
  }

  /* ═══ FASE 2 · MOTOR DE CÁLCULO Y DIAGNÓSTICO FISCAL ═══ */
  // Fuente de activos (módulo Mapa abierto → mp.assets; si no, estado persistente).
  function pfFuenteActivos(){
    if(typeof mp!=='undefined' && Array.isArray(mp.assets) && mp.assets.length) return {acts:mp.assets, trm:mp.trm||{}};
    const mpp = state.mapaPatrimonial || {}; return {acts:mpp.activos||[], trm:mpp.trm||{}};
  }
  function pfMontoCOP(val, currency, trm){ let v=+val||0; if(currency && currency!=='COP'){ const t=trm[currency]; if(t) v=v*t; } return v; }

  // Detalle ESTRICTO del ingreso anual, por fuente, con deduplicación explícita.
  // Cada línea manual (M1, variable, no periódico) lleva una clave; si está en state.fiscal.ingresosExcluidos
  // (porque ya proviene de un activo), NO se suma. El ingreso de activos es la fuente canónica y siempre se cuenta.
  function pfIngresoDetalle(){
    const f = state.fiscal;
    const excl = f.ingresosExcluidos || {};
    const lineas = [];
    (state.ingresos||[]).forEach((ing,i)=>{
      if(ing && ing.linkedToMVar) return;   // línea sincronizada del ingreso variable: se cuenta abajo con el detalle real, no aquí
      const monto = +ing.monto||0; if(monto<=0) return;
      const key = 'm1:'+(ing.nombre||('fila'+i));
      lineas.push({ key, fuente:'Laboral / fijo (M1)', clase:'trabajo', nombre: ing.nombre||'Ingreso', anual: monto*12, excluido: !!excl[key] });
    });
    const v = state.varIncome;
    if(v && v.active && Array.isArray(v.contratos)){
      // Consolidamos los meses por fecha (suma entre contratos el mismo mes), tomamos los 12 MÁS RECIENTES y sumamos el bruto real.
      let combinados = [];
      try { combinados = getCombinedMeses().filter(m=>(+m.bruto||0)>0); } catch(e){ combinados = []; }
      combinados.sort((a,b)=>((a.anio||0)*12+(a.monthIdx||0))-((b.anio||0)*12+(b.monthIdx||0)));
      const last12 = combinados.slice(-12);
      if(last12.length>0){
        const anual = last12.reduce((s,m)=>s+(+m.bruto||0),0);   // suma REAL de los meses (sin anualizar → no infla)
        const keys = new Set(last12.map(m=>(m.anio||0)*12+(m.monthIdx||0)));
        // Retención: por contrato, bruto de sus meses dentro de la ventana × su % de retención
        let retencion = 0;
        v.contratos.forEach(c=>{
          if(!c || !c.retencionAplica) return;
          const pct = (+c.retencionPct||0)/100;
          (c.meses||[]).forEach(m=>{ if(m && keys.has((m.anio||0)*12+(m.monthIdx||0))) retencion += (+m.bruto||0)*pct; });
        });
        const key = 'var:consolidado';
        lineas.push({ key, fuente:'Variable', clase:'trabajo', nombre:'Ingresos variables ('+last12.length+' meses)', anual, retencion:Math.round(retencion), mesesUsados:last12.length, excluido: !!excl[key] });
      }
    }
    ((state.p5&&state.p5.ingresos)||[]).forEach((r,i)=>{
      if(r.yaEnM1) return;
      const monto = +r.monto||0; if(monto<=0) return;
      const anual = (r.frec==='TODOS LOS MESES') ? monto*12 : monto;
      const key = 'p5:'+(r.nombre||('fila'+i));
      lineas.push({ key, fuente:'No periódico (M5)', clase:'noLaboral', nombre: r.nombre||'Ingreso', anual, excluido: !!excl[key] });
    });
    const {acts,trm} = pfFuenteActivos();
    const deActivos = acts.reduce((s,a)=>{ if(!a)return s; const im=+a.monthlyIncome||0; if(im<=0)return s; return s + pfMontoCOP(im,a.currency,trm)*12; },0);
    // ── FASE D · Puente con el presupuesto real ──────────────────────────────
    // Reemplaza el ×12 del ingreso fijo (M1) por la suma REAL de los meses del presupuesto,
    // SOLO si el ingreso fijo es la única fuente (sin variable, activos ni no periódicos) y
    // ninguna línea del M1 está excluida. Así nunca duplica ni deja fuera otras fuentes.
    let fuenteReal=false, mesesReales=0;
    try{
      const varTot = lineas.filter(l=>l.fuente==='Variable' && !l.excluido).reduce((s,l)=>s+l.anual,0);
      const noPer  = lineas.filter(l=>l.fuente.indexOf('No periódico')===0 && !l.excluido).reduce((s,l)=>s+l.anual,0);
      const m1Lines = lineas.filter(l=>l.fuente.indexOf('Laboral')===0);
      const m1Excluidas = m1Lines.some(l=>l.excluido);
      const hayOtras = varTot>0 || deActivos>0 || noPer>0;
      if(!hayOtras && !m1Excluidas){
        const bud = pgIngresoAnioFiscal(pgAnio());
        if(bud.hayAlguno){
          for(let i=lineas.length-1;i>=0;i--){ if(lineas[i].fuente.indexOf('Laboral')===0) lineas.splice(i,1); }
          lineas.push({ key:'pg:real', fuente:'Presupuesto (real)', clase:'trabajo', nombre:'Ingreso registrado del año'+(bud.reales<12?' ('+bud.reales+'/12 meses reales, resto estimado)':''), anual: bud.total, excluido:false, real:true });
          fuenteReal=true; mesesReales=bud.reales;
        }
      }
    }catch(e){}
    const vivas = lineas.filter(l=>!l.excluido);
    const manualContado = vivas.reduce((s,l)=>s+l.anual,0);
    return { lineas, deActivos, fuenteReal, mesesReales, total: manualContado + deActivos,
             // Rentas de trabajo (salarios, honorarios) vs no laborales/capital (M5, arriendos y rendimientos de activos)
             ingresoTrabajo: vivas.filter(l=>l.clase==='trabajo').reduce((s,l)=>s+l.anual,0),
             ingresoNoLaboral: vivas.filter(l=>l.clase!=='trabajo').reduce((s,l)=>s+l.anual,0) + deActivos,
             laboral: vivas.filter(l=>l.fuente.indexOf('Laboral')===0).reduce((s,l)=>s+l.anual,0),
             variable: vivas.filter(l=>l.fuente==='Variable').reduce((s,l)=>s+l.anual,0),
             retencionDetectada: vivas.reduce((s,l)=>s+(l.retencion||0),0),
             noPeriodico: vivas.filter(l=>l.fuente.indexOf('No periódico')===0).reduce((s,l)=>s+l.anual,0) };
  }
  function pfIngresoAnualBruto(){ return pfIngresoDetalle().total; }
  function pfPatrimonioBruto(){
    // 1) Si el Mapa Patrimonial está hidratado en memoria, usar su cálculo (incluye TRM y % de propiedad).
    try{ const g = totalGrossAssets(); if(g>0) return g; }catch(e){}
    // 2) Fallback robusto: leer del estado persistido (por si el mapa aún no se hidrató al abrir el módulo fiscal).
    try{
      const data = state.mapaPatrimonial || {};
      const acts = data.activos || [];
      const trm = data.trm || {};
      return acts.reduce((s,a)=>{
        if(!a) return s;
        let v = +a.value || 0;
        if(a.currency && a.currency!=='COP') v = v * (+trm[a.currency] || 0);
        const pct = (a.porcentajePropio!=null && a.porcentajePropio>0 && a.porcentajePropio<=100) ? a.porcentajePropio : 100;
        return s + v*pct/100;
      }, 0);
    }catch(e){ return 0; }
  }

  // Impuesto de renta por la tabla del art. 241 (en UVT). impUVT = (baseUVT − desde)×tarifa + acumulado.
  function aplicarTabla241(basePesos){
    const tabla = ((fiscalConfig().renta)||{}).tabla241 || [];
    if(!tabla.length || basePesos<=0) return 0;
    const bgUVT = basePesos / uvtValor();
    let r = tabla.find(x => bgUVT > x.desde && (x.hasta==null || bgUVT <= x.hasta));
    if(!r) r = tabla[0];
    return Math.round(Math.max(0, (bgUVT - r.desde) * r.tarifa + (r.baseUVT||0)) * uvtValor());
  }

  function pfDebeDeclarar(){
    const t = (fiscalConfig().topesDeclaracion)||{};
    const f = state.fiscal;
    const ingresos = pfIngresoAnualBruto();
    const patrimonio = pfPatrimonioBruto();
    const criterios = [];
    criterios.push({k:'Patrimonio bruto', uvt:t.patrimonioBruto, v:patrimonio, tope:enPesos(t.patrimonioBruto), supera: patrimonio > enPesos(t.patrimonioBruto)});
    criterios.push({k:'Ingresos brutos', uvt:t.ingresosBrutos, v:ingresos, tope:enPesos(t.ingresosBrutos), supera: ingresos >= enPesos(t.ingresosBrutos)});
    criterios.push({k:'Consumos con tarjeta de crédito', uvt:t.consumosTarjeta, v:(f.consumosTarjeta||0), tope:enPesos(t.consumosTarjeta), supera:(f.consumosTarjeta||0) > enPesos(t.consumosTarjeta)});
    criterios.push({k:'Compras y consumos totales', uvt:t.comprasConsumos, v:(f.comprasConsumos||0), tope:enPesos(t.comprasConsumos), supera:(f.comprasConsumos||0) > enPesos(t.comprasConsumos)});
    criterios.push({k:'Consignaciones y depósitos', uvt:t.consignaciones, v:(f.consignaciones||0), tope:enPesos(t.consignaciones), supera:(f.consignaciones||0) > enPesos(t.consignaciones)});
    criterios.push({k:'Ser responsable de IVA', uvt:null, v:null, tope:null, supera: !!(f.resp && f.resp.iva)});
    const razones = criterios.filter(c=>c.supera);
    return { debe: razones.length>0, razones, criterios, ingresos, patrimonio };
  }

  // ¿Está obligado a presentar información exógena? (persona natural, AG 2025 · Res. DIAN 000227/2025)
  function pfExogenaObligado(){
    const f = state.fiscal;
    const ex = (fiscalConfig().exogena)||(FISCAL_DEFAULT.exogena)||{};
    const ingresos = pfIngresoAnualBruto();
    // 1) Agente de retención: obligado sin importar el monto.
    if(f.resp && f.resp.retencion) return { obligado:true, motivo:'retencion' };
    // 2) Marcado manualmente en el perfil.
    if(f.resp && f.resp.exogena) return { obligado:true, motivo:'marcado' };
    // 3) Régimen Simple con ingresos sobre el tope.
    if(f.regimen==='simple' && ingresos > enPesos(ex.simplePNUVT||11800)) return { obligado:true, motivo:'simple' };
    // 4) Ordinario: ingresos sobre 11.800 UVT (2ª condición de rentas de capital/no laborales la valida el contador).
    if(ingresos > enPesos(ex.ingresosPNUVT||11800)) return { obligado:'revisar', motivo:'ingresos' };
    return { obligado:false, motivo:null };
  }

  // Aporte obligatorio a seguridad social: usa lo registrado; si está vacío, lo estima según el tipo de ingreso.
  function pfAporteSegSocial(){
    const f = state.fiscal;
    const manual = (f.segSocial.salud||0) + (f.segSocial.pension||0);
    if(manual > 0) return { valor: manual, origen:'registrado' };
    const ingreso = pfIngresoAnualBruto();
    const tipo = (state.profile && state.profile.tipoIngreso) || 'independiente';
    let valor;
    if(tipo === 'empleado') valor = ingreso * 0.08;              // 4% salud + 4% pensión (parte del empleado)
    else valor = (ingreso * 0.40) * 0.285;                       // independiente/mixto: IBC 40% × (12,5% salud + 16% pensión)
    return { valor: Math.round(valor), origen:'estimado', tipo };
  }

  // Detecta medicina prepagada / pólizas de salud ya registradas en los gastos (categoría salud).
  function pfPrepagadaAnual(){
    const items = (state.gastosItems && state.gastosItems['salud']) || [];
    let mensual = 0;
    items.forEach(it=>{
      const n = ((it && it.nombre)||'').toLowerCase();
      if(/prepagad|p[oó]liza|seguro|complementari|plan compl/.test(n)) mensual += +it.monto||0;
    });
    return Math.round(mensual*12);
  }
  // Detecta si tiene productos con beneficio tributario (FPV/AFC/seguro de pensión) registrados como activos.
  function pfTieneFPV(){
    const {acts} = pfFuenteActivos();
    return acts.some(a=> a && (a.beneficioTributario || a.subtype==='Fondo de pensiones voluntarias FPV' || a.subtype==='Cuenta AFC' || a.subtype==='Seguro de pensión con ahorro'));
  }
  // Estima los intereses de vivienda del año desde el módulo de deudas (crédito hipotecario): saldo × tasa E.A.
  function pfInteresesViviendaAuto(){
    return (state.deudas||[]).reduce((s,d)=>{
      if(!d) return s;
      const esHipo = d.tipo==='APAL_HIPOTECA' || /hipotec|habitacional|vivienda/i.test(d.nombre||'');
      if(!esHipo) return s;
      return s + (+d.saldo||0) * (+d.tasa_anual||0);
    }, 0);
  }

  // Tabla art. 383 (retención mensual sobre la base depurada en UVT). Bases acumuladas en UVT.
  function aplicarTabla383(baseMesPesos){
    const u = (baseMesPesos||0) / uvtValor();
    let impUVT;
    if(u<=95) impUVT=0;
    else if(u<=150) impUVT=(u-95)*0.19;
    else if(u<=360) impUVT=(u-150)*0.28+10.45;
    else if(u<=640) impUVT=(u-360)*0.33+69.25;
    else if(u<=945) impUVT=(u-640)*0.35+161.65;
    else if(u<=2300) impUVT=(u-945)*0.37+268.40;
    else impUVT=(u-2300)*0.39+769.75;
    return Math.max(0, Math.round(impUVT * uvtValor()));
  }
  // Estima la retefuente del año sobre rentas de trabajo (art. 383), mensualizando la base gravable atribuible a trabajo.
  function pfRetencionTrabajoEstimada(){
    const r = pfRentaEstimada();
    if(r.esSimple || r.ingresoTrabajo<=0 || r.ingresos<=0) return 0;
    const baseTrabajoAnual = r.baseGravable * (r.ingresoTrabajo / r.ingresos);
    return aplicarTabla383(baseTrabajoAnual/12) * 12;
  }

  function pfRentaEstimada(opts){
    opts = opts || {};
    const f = state.fiscal;
    const det = pfIngresoDetalle();
    const ingresos = det.total;
    const esSimple = f.regimen === 'simple';
    const seg = pfAporteSegSocial();
    const incrngo = seg.valor;                                   // aportes obligatorios (salud INCR + pensión exenta)
    const rentaLiquida = Math.max(0, ingresos - incrngo);
    // Nota: la cascada ordinaria se calcula SIEMPRE (aunque el usuario esté en Simple) para poder comparar los dos regímenes.
    const trabajoNeto = Math.max(0, det.ingresoTrabajo - incrngo);
    const tipo = (state.profile && state.profile.tipoIngreso) || '';
    const exenta25 = tipo ? 0.25 * trabajoNeto : 0;              // 25% renta exenta de trabajo (art. 206-10), solo rentas de trabajo
    const dep = (state.profile && +state.profile.dependientes) || 0;
    const hayTrabajo = det.ingresoTrabajo > 0;
    const esLaboral = (tipo === 'empleado' || tipo === 'mixto');     // tiene relación laboral
    const dep387 = (dep>0 && hayTrabajo && esLaboral) ? Math.min(0.10*det.ingresoTrabajo, enPesos(384)) : 0;   // dentro del tope
    const dep336 = (dep>0 && hayTrabajo) ? enPesos(72 * Math.min(dep,4)) : 0;                                   // fuera del tope
    const viviendaAuto = pfInteresesViviendaAuto();
    const viviendaBase = (f.interesesVivienda>0) ? f.interesesVivienda : viviendaAuto;
    const dedVivienda = Math.min(viviendaBase, enPesos(1200));
    const viviendaEsAuto = !(f.interesesVivienda>0) && viviendaAuto>0;
    const dedGMF = Math.round((f.gmf||0) * 0.50);                // 50% del 4x1000 (art. 115)
    const prepagadaAnual = pfPrepagadaAnual();
    const dedSalud = Math.min(prepagadaAnual, enPesos(16*12));   // medicina prepagada, tope 16 UVT/mes
    const aporteVolBase = (opts.aporteVolOverride!=null) ? opts.aporteVolOverride : (f.aporteVoluntario||0);
    const aporteVolReg = Math.min(aporteVolBase, 0.30*ingresos, enPesos(3800));  // FPV/AFC, tope 30% / 3.800 UVT
    const topeBeneficios = Math.min(0.40 * rentaLiquida, enPesos(((fiscalConfig().renta||{}).limiteRentasExentasDeducciones||{}).topeUVT || 1340));
    const beneficios = Math.min(dep387 + dedVivienda + dedGMF + dedSalud + aporteVolReg + exenta25, topeBeneficios);
    const baseGravable = Math.max(0, rentaLiquida - beneficios - dep336);   // dep336 va por fuera del tope
    const impuesto = aplicarTabla241(baseGravable);
    const retencion = (f.retencion>0) ? f.retencion : (det.retencionDetectada||0);
    const retencionEsAuto = !(f.retencion>0) && (det.retencionDetectada||0)>0;
    return {
      esSimple, ingresos, det, seg, incrngo, rentaLiquida, ingresoTrabajo:det.ingresoTrabajo, ingresoNoLaboral:det.ingresoNoLaboral,
      trabajoNeto, exenta25, dep, hayTrabajo, esLaboral, dep387, dep336, dedVivienda, viviendaEsAuto, dedGMF, dedSalud, prepagadaAnual, aporteVolReg, topeBeneficios, beneficios, baseGravable, impuesto,
      retencion, retencionEsAuto, saldo: impuesto - retencion, baseSinDeduc: rentaLiquida
    };
  }

  function pfIvaPeriodo(){
    const f = state.fiscal;
    if(!(f.resp && f.resp.iva)) return null;
    const tarifa = (fiscalConfig().iva||{}).tarifaGeneral || 0.19;
    const generado = Math.round((f.iva.ventasGravadas||0) * tarifa);
    const descontable = Math.round((f.iva.comprasConIva||0) * tarifa);
    return { generado, descontable, saldo: generado - descontable, tarifa };
  }

  function pfIcaEstimado(){
    const f = state.fiscal;
    if(!(f.resp && f.resp.ica)) return null;
    if(f.regimen === 'simple') return { integradoSimple:true };
    const ingresos = pfIngresoAnualBruto();
    const ica = (fiscalConfig().ica)||{};
    const muni = ica.medellin || Object.values(ica)[0];
    if(!muni || !muni.tarifasPorMil) return { ingresos, sinTarifa:true };
    const porMil = muni.tarifasPorMil.servicios || muni.tarifasPorMil.comercio || 0;
    return { ingresos, municipio:muni.nombre, porMil, valor: Math.round(ingresos * porMil / 1000) };
  }

  function pfSimpleEstimado(grupoId){
    const cfg = fiscalConfig().simple || {};
    const grupos = (cfg.grupos && cfg.grupos.length) ? cfg.grupos : ((FISCAL_DEFAULT.simple||{}).grupos||[]);
    if(!grupos.length) return null;
    const grupo = grupos.find(g=>g.id===grupoId) || grupos[grupos.length-1];
    const ingresos = pfIngresoAnualBruto();
    const uvt = uvtValor();
    const ingresosUVT = ingresos / uvt;
    const r = (grupo.rangos||[]).find(x=> ingresosUVT >= x.desde && ingresosUVT < x.hasta) || (grupo.rangos||[])[(grupo.rangos||[]).length-1];
    const tarifa = r ? r.tarifa : 0;
    const impuesto = Math.round(ingresos * tarifa);
    return { grupo, tarifa, impuesto, ingresos, ingresosUVT, excedeTope: ingresosUVT > (cfg.topeIngresosUVT||100000), incConsumo: grupo.incConsumo||0 };
  }

  // Elegibilidad para el Régimen Simple. Combina lo automático (ingresos, perfil) con las respuestas del usuario. Lenguaje simple: lo lee el usuario.
  function pfElegibleSimple(){
    const det = pfIngresoDetalle();
    const ingresos = det.total;
    const uvt = uvtValor();
    const topeUVT = (fiscalConfig().simple||{}).topeIngresosUVT || 100000;
    const sc = (state.fiscal && state.fiscal.simpleCheck) || {};
    const motivos = [], advertencias = [];
    if(ingresos>0 && ingresos/uvt >= topeUVT)
      motivos.push('Tus ingresos ('+fmt(ingresos)+') pasan el tope del Simple, que es de '+fmt(enPesos(topeUVT))+' al año. Por encima de ese monto no se puede usar.');
    const tipo = (state.profile && state.profile.tipoIngreso) || '';
    if(tipo === 'empleado')
      motivos.push('Tus ingresos son de un sueldo como empleado. El Simple es para quien trabaja por su cuenta o tiene un negocio, no para empleados.');
    else if(tipo === 'mixto')
      advertencias.push('Tienes sueldo de empleado y también ingresos por tu cuenta. La parte del sueldo no entra al Simple; la comparación aplica solo a lo que ganas por tu cuenta.');
    const pasivo = det.deActivos || 0;
    if(ingresos>0 && pasivo/ingresos >= 0.20)
      motivos.push('Tus ingresos por arriendos y rendimientos ('+fmt(pasivo)+') son el '+Math.round(pasivo/ingresos*100)+'% de todo lo que ganas. Cuando eso llega al 20% o más, no se puede usar el Simple.');
    if(sc.residente === 'no')
      motivos.push('Para usar el Simple debes vivir en Colombia la mayor parte del año.');
    if(sc.actividad === 'si')
      motivos.push('Tu actividad principal es una de las que no pueden usar el Simple (como asesoría en inversiones o créditos, préstamos, energía, venta de carros, combustibles o armas).');
    if(sc.realidad === 'si')
      motivos.push('Aunque factures por tu cuenta, en la práctica trabajas como empleado de una sola empresa, así que no puedes usar el Simple.');
    if(sc.aldia === 'no')
      motivos.push('Para entrar al Simple debes estar al día con la DIAN y con tus aportes de salud y pensión.');
    if(sc.factura === 'no')
      advertencias.push('Para pasarte al Simple vas a necesitar tener RUT y factura electrónica. Puedes sacarlos antes de inscribirte.');
    if(sc.socio === 'si')
      advertencias.push('Como eres socio o dueño de otras empresas, tus ingresos se suman con los de ellas para el límite. Vale la pena revisarlo con cuidado.');
    const faltan = ['residente','actividad','realidad','aldia','factura','socio'].filter(k=>!sc[k]).length;
    if(faltan>0 && motivos.length===0)
      advertencias.push('Te faltan '+faltan+' pregunta(s) por responder en el Perfil fiscal (sección "¿Puedes usar el Régimen Simple?"). Complétalas para estar seguro.');
    advertencias.push('Si te conviene y cumples, el cambio al Simple se solicita una vez al año, hasta el último día hábil de febrero.');
    return { elegible: motivos.length===0, motivos, advertencias };
  }

  function pfComparadorHtml(){
    const f = state.fiscal;
    const renta = pfRentaEstimada();
    if(renta.ingresos<=0) return '';
    const elig = pfElegibleSimple();
    if(!elig.elegible){
      let h = '<div class="pf-diag-card"><div class="pf-diag-t">Régimen Simple: no aplicable a tu caso</div>';
      h += '<p class="pf-note" style="margin-top:0">Con tus datos actuales no podrías optar por el Régimen Simple, así que compararlo no aportaría. Las razones:</p>';
      elig.motivos.forEach(m=> h += '<div class="pf-vuln sev-media"><div class="pf-vuln-ico">!</div><div class="pf-vuln-body"><div class="pf-vuln-d">'+m+'</div></div></div>');
      h += '<p class="pf-note">Requisitos completos en los artículos 905 y 906 del Estatuto Tributario. Tu asesor confirma la elegibilidad.</p></div>';
      return h;
    }
    let icaOrd = 0;
    if(f.resp && f.resp.ica){
      const ica=(fiscalConfig().ica)||{}; const muni=ica.medellin||Object.values(ica)[0];
      if(muni&&muni.tarifasPorMil){ const pm=muni.tarifasPorMil.servicios||muni.tarifasPorMil.comercio||0; icaOrd=Math.round(renta.ingresos*pm/1000); }
    }
    const ordTotal = renta.impuesto + icaOrd;
    const grupoId = +f.simpleGrupo||4;
    const simple = pfSimpleEstimado(grupoId);
    if(!simple) return '';
    const ordGana = ordTotal <= simple.impuesto;
    const dif = Math.abs(ordTotal - simple.impuesto);
    const grupos = ((fiscalConfig().simple||{}).grupos||[]).length ? (fiscalConfig().simple||{}).grupos : ((FISCAL_DEFAULT.simple||{}).grupos||[]);
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">¿Ordinario o Simple?</div>';
    html += '<p class="pf-note" style="margin-top:0">El Régimen Simple reemplaza renta e ICA por una sola tarifa plana sobre tus ingresos brutos. Con tus cifras:</p>';
    html += '<label class="pf-mini-label">Tu actividad en el Simple</label><select id="pf-simple-grupo" class="pf-select">';
    grupos.forEach(g=>{ html += '<option value="'+g.id+'"'+(g.id===grupoId?' selected':'')+'>'+g.nombre+'</option>'; });
    html += '</select>';
    html += '<div class="pf-vs">';
    html += '<div class="pf-vs-col'+(ordGana?' win':'')+'">'+(ordGana?'<span class="pf-vs-badge">Te conviene</span>':'')+'<div class="pf-vs-name">Ordinario</div><div class="pf-vs-total">'+fmt(ordTotal)+'</div><div class="pf-vs-detail"><span>Renta <b>'+fmt(renta.impuesto)+'</b></span><span>ICA <b>'+fmt(icaOrd)+'</b></span></div></div>';
    html += '<div class="pf-vs-col'+(!ordGana?' win':'')+'">'+(!ordGana?'<span class="pf-vs-badge">Te conviene</span>':'')+'<div class="pf-vs-name">Simple</div><div class="pf-vs-total">'+fmt(simple.impuesto)+'</div><div class="pf-vs-detail"><span>Tarifa <b>'+(simple.tarifa*100).toFixed(1)+'%</b></span><span>Renta + ICA integrados</span></div></div>';
    html += '</div>';
    html += '<div class="pf-diag-out"><span>'+(ordGana?'El Ordinario te ahorra':'El Simple te ahorra')+'</span><b>'+fmt(dif)+'</b></div>';
    html += '<p class="pf-note">'+(simple.excedeTope?'<strong>⚠ Superas el tope de 100.000 UVT</strong>, no podrías optar por el Simple. ':'')+'En el Simple <strong>pierdes las deducciones</strong> (dependientes, aportes voluntarios, vivienda, 25% exento). El IVA sigue aparte en ambos, y el cambio de régimen se hace una vez al año en los plazos de la DIAN.'+(simple.incConsumo>0?' Si vendes comidas y bebidas, suma 8% de INC.':'')+'</p>';
    if(elig.advertencias && elig.advertencias.length){
      html += '<div class="pf-simple-adv"><strong>Antes de decidir, confirma:</strong>';
      elig.advertencias.forEach(a=> html += '<div class="pf-simple-adv-i">• '+a+'</div>');
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function pfOptimizadorHtml(){
    const f = state.fiscal;
    const renta = pfRentaEstimada();
    if(renta.esSimple || renta.ingresos<=0) return '';
    const maxAporte = Math.round(Math.min(0.30*renta.ingresos, enPesos(3800)));
    if(maxAporte<=0) return '';
    const actual = Math.min(f.aporteVoluntario||0, maxAporte);
    const impSin = pfRentaEstimada({aporteVolOverride:0}).impuesto;
    const impCon = pfRentaEstimada({aporteVolOverride:actual}).impuesto;
    const step = Math.max(100000, Math.round(maxAporte/100/100000)*100000);
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">Optimizador: aporte a pensión voluntaria / AFC</div>';
    html += '<p class="pf-note" style="margin-top:0">Cada peso que aportes (hasta el 30% de tu ingreso, tope 3.800 UVT) baja tu base de renta. Mueve el control:</p>';
    html += '<div class="pf-opt-top"><span>Aporte al año</span><span class="pf-opt-val" id="pf-opt-val">'+fmt(actual)+'</span></div>';
    html += '<input type="range" id="pf-opt-slider" min="0" max="'+maxAporte+'" step="'+step+'" value="'+actual+'" class="pf-range">';
    html += '<div class="pf-vs" style="margin-top:6px">';
    html += '<div class="pf-vs-col"><div class="pf-vs-name">Impuesto con el aporte</div><div class="pf-vs-total" id="pf-opt-imp">'+fmt(impCon)+'</div></div>';
    html += '<div class="pf-vs-col win"><div class="pf-vs-name">Ahorro vs no aportar</div><div class="pf-vs-total" id="pf-opt-ahorro">'+fmt(impSin-impCon)+'</div></div>';
    html += '</div>';
    html += '<p class="pf-note">Además del ahorro tributario, ese dinero queda invertido a tu nombre para tu retiro. El cupo máximo con tu ingreso es '+fmt(maxAporte)+'.</p>';
    html += '<button class="pf-cta-mini" data-cta-whatsapp style="margin-top:4px">Quiero aprovechar mi cupo</button>';
    html += '</div>';
    return html;
  }

  // Impuesto de renta personal aproximado sobre un monto de rentas de trabajo (para el sueldo que te pagas desde la SAS).
  // Impuesto de renta sobre el sueldo que te pagas desde la SAS, con TODAS las deducciones del cliente y aportes calculados.
  function pfRentaSobreSalario(salario){
    if(salario<=0) return { impuesto:0, aportes:0, base:0 };
    const f = state.fiscal;
    const smmlv = ((fiscalConfig().sas)||{}).smmlv || 1423500;
    // aportes obligatorios del trabajador: salud 4% + pensión 4% (+ 1% fondo de solidaridad si el sueldo mensual ≥ 4 SMMLV)
    let tasa = 0.08;
    if((salario/12) >= 4*smmlv) tasa += 0.01;
    const aportes = Math.round(salario * tasa);
    const neto = salario - aportes;
    const exenta25 = 0.25 * neto;                                  // 25% exento (es empleado de la SAS → renta de trabajo)
    const dep = (state.profile && +state.profile.dependientes) || 0;
    const dep387 = (dep>0) ? Math.min(0.10*salario, enPesos(384)) : 0;   // relación laboral → aplica el 10%
    const dep336 = (dep>0) ? enPesos(72*Math.min(dep,4)) : 0;
    const viviendaAuto = pfInteresesViviendaAuto();
    const dedVivienda = Math.min((f.interesesVivienda>0?f.interesesVivienda:viviendaAuto), enPesos(1200));
    const dedGMF = Math.round((f.gmf||0)*0.50);
    const dedSalud = Math.min(pfPrepagadaAnual(), enPesos(16*12));
    const aporteVolReg = Math.min(f.aporteVoluntario||0, 0.30*salario, enPesos(3800));
    const tope = Math.min(0.40*neto, enPesos(1340));
    const beneficios = Math.min(dep387+dedVivienda+dedGMF+dedSalud+aporteVolReg+exenta25, tope);
    const base = Math.max(0, neto - beneficios - dep336);
    return { impuesto: aplicarTabla241(base), aportes, base };
  }

  function pfSasEstimado(opts){
    opts = opts || {};
    const cfg = (fiscalConfig().sas) || (FISCAL_DEFAULT.sas) || {};
    const s = (state.fiscal && state.fiscal.sas) || {};
    const det = pfIngresoDetalle();
    const ingresos = det.total;
    const costosNegocio = (opts.costosNegocio!=null) ? opts.costosNegocio : (+s.costosNegocio||0);
    const salario = (opts.salario!=null) ? opts.salario : (+s.salario||0);
    const costosAnuales = (opts.costosAnuales!=null) ? opts.costosAnuales : (s.costosAnuales!=null ? +s.costosAnuales : (cfg.costoAnualTipico||6000000));
    const repartoPct = (opts.repartoPct!=null) ? opts.repartoPct : (s.repartoPct!=null ? +s.repartoPct : 100);
    const utilidad = Math.max(0, ingresos - costosNegocio - salario);   // el sueldo también lo descuenta la empresa
    const impuestoRenta = Math.round((cfg.tarifaRenta||0.35) * utilidad);
    const utilidadDespues = utilidad - impuestoRenta;
    const dividendos = Math.round(utilidadDespues * (repartoPct/100));
    const exento = enPesos(cfg.dividendoExentoUVT||1090);
    const impuestoDividendos = Math.round((cfg.dividendoTarifa||0.15) * Math.max(0, dividendos - exento));
    const salT = pfRentaSobreSalario(salario);                          // impuesto de renta del sueldo con las deducciones del cliente
    const impuestoSalario = salT.impuesto;
    const aportesSalario = salT.aportes;
    const totalImpuestos = impuestoRenta + impuestoDividendos + impuestoSalario;
    const total = totalImpuestos + costosAnuales;                       // total en impuestos + costo de la SAS (los aportes van aparte)
    const smmlv = cfg.smmlv || 1423500;
    const requiereRevisor = ingresos >= (cfg.revisorFiscalIngresosSMMLV||3000)*smmlv;
    return { ingresos, costosNegocio, salario, utilidad, impuestoRenta, utilidadDespues, dividendos, impuestoDividendos, impuestoSalario, aportesSalario, repartoPct, totalImpuestos, costosAnuales, total, requiereRevisor };
  }

  // Elegibilidad de una SAS (persona jurídica) para el Régimen Simple. El tope depende de la actividad (Art. 905/906/908).
  function pfSasElegibleSimple(){
    const cfgS = (fiscalConfig().simple) || (FISCAL_DEFAULT.simple) || {};
    const det = pfIngresoDetalle(); const ingresos = det.total; const uvt = uvtValor();
    const grupoId = +((state.fiscal && state.fiscal.simpleGrupo)) || 4;
    const esProfesional = (grupoId === 4);                    // servicios profesionales / profesiones liberales → tope menor
    const topeUVT = esProfesional ? (cfgS.topeProfesionalesUVT||12000) : (cfgS.topeIngresosUVT||100000);
    const motivos = [];
    if(ingresos>0 && ingresos/uvt >= topeUVT)
      motivos.push('Los ingresos ('+fmt(ingresos)+') superan el tope del Simple para tu actividad: '+topeUVT.toLocaleString('es-CO')+' UVT ('+fmt(enPesos(topeUVT))+' al año). Por encima de eso, la SAS no puede acogerse al Simple.');
    return { elegible: motivos.length===0, motivos, topeUVT, esProfesional };
  }

  // SAS en Régimen SIMPLE: tarifa plana sobre ingresos brutos (no resta costos) + dividendos GRAVADOS + sueldo.
  function pfSasSimpleEstimado(opts){
    opts = opts || {};
    const cfg = (fiscalConfig().sas) || (FISCAL_DEFAULT.sas) || {};
    const cfgS = (fiscalConfig().simple) || (FISCAL_DEFAULT.simple) || {};
    const s = (state.fiscal && state.fiscal.sas) || {};
    const det = pfIngresoDetalle();
    const ingresos = det.total;
    const costosNegocio = (opts.costosNegocio!=null) ? opts.costosNegocio : (+s.costosNegocio||0);
    const salario = (opts.salario!=null) ? opts.salario : (+s.salario||0);
    const costosAnuales = (opts.costosAnuales!=null) ? opts.costosAnuales : (s.costosAnuales!=null ? +s.costosAnuales : (cfg.costoAnualTipico||6000000));
    const repartoPct = (opts.repartoPct!=null) ? opts.repartoPct : (s.repartoPct!=null ? +s.repartoPct : 100);
    // Impuesto SIMPLE de la empresa: tarifa PLANA por rango sobre ingresos BRUTOS (no se restan costos). Art. 908.
    const uvt = uvtValor(); const ingresosUVT = ingresos/uvt;
    const grupoId = +((state.fiscal && state.fiscal.simpleGrupo)) || 4;
    const grupos = (cfgS.grupos && cfgS.grupos.length) ? cfgS.grupos : ((FISCAL_DEFAULT.simple||{}).grupos||[]);
    const grupo = grupos.find(g=>g.id===grupoId) || grupos[grupos.length-1];
    const r = (grupo.rangos||[]).find(x=> ingresosUVT >= x.desde && ingresosUVT < x.hasta) || (grupo.rangos||[])[(grupo.rangos||[]).length-1];
    const tarifa = r ? r.tarifa : 0;
    const impuestoSimple = Math.round(ingresos * tarifa);
    // Sueldo: gravado como persona natural, con las mismas deducciones (igual que en ordinario).
    const salT = pfRentaSobreSalario(salario);
    const impuestoSalario = salT.impuesto; const aportesSalario = salT.aportes;
    // Base de caja para repartir (después del impuesto SIMPLE, costos y sueldo).
    const utilidad = Math.max(0, ingresos - costosNegocio - salario - impuestoSimple);
    const dividendos = Math.round(utilidad * (repartoPct/100));
    // Dividendos GRAVADOS: en Simple las utilidades NO son depuradas (Art. 48/49 no aplican). Cascada Art. 242: tarifa de renta y luego tarifa de dividendo sobre el remanente.
    const tarRenta = cfg.tarifaRenta||0.35; const exento = enPesos(cfg.dividendoExentoUVT||1090); const tarDiv = cfg.dividendoTarifa||0.15;
    const divNivel1 = Math.round(tarRenta * dividendos);
    const divNivel2 = Math.round(tarDiv * Math.max(0, (dividendos - divNivel1) - exento));
    const impuestoDividendos = divNivel1 + divNivel2;
    const totalImpuestos = impuestoSimple + impuestoDividendos + impuestoSalario;
    const total = totalImpuestos + costosAnuales;
    return { regimen:'simple', grupoId, grupoNombre:(grupo&&grupo.nombre)||'', tarifa, ingresos, ingresosUVT, costosNegocio, salario, utilidad, impuestoSimple, dividendos, impuestoDividendos, impuestoSalario, aportesSalario, repartoPct, totalImpuestos, costosAnuales, total };
  }

  // Parte DINÁMICA del simulador SAS: desglose Ordinario vs Simple + comparación a 3 (se re-renderiza al cambiar montos/reparto).
  function pfSasCompHtml(){
    const pn = pfRentaEstimada().impuesto;
    const sas = pfSasEstimado();
    const sasS = pfSasSimpleEstimado();
    const eligS = pfSasElegibleSimple();
    const exento = enPesos((fiscalConfig().sas||{}).dividendoExentoUVT||1090);
    const pct = (x)=> Math.round((x||0)*1000)/10;
    let h = '';
    // ── SAS · ORDINARIO ──
    h += '<div class="pf-diag-sub">SAS en régimen Ordinario <span class="pf-mut">(renta 35% · Art. 240)</span></div>';
    h += '<div class="pf-diag-row"><span>Tus ingresos del año</span><b>'+fmt(sas.ingresos)+'</b></div>';
    h += '<div class="pf-diag-row"><span>− Costos de tu negocio</span><b>−'+fmt(sas.costosNegocio)+'</b></div>';
    h += '<div class="pf-diag-row"><span>− Sueldo que te pagas</span><b>−'+fmt(sas.salario)+'</b></div>';
    h += '<div class="pf-diag-row pf-diag-strong"><span>= Utilidad de la empresa</span><b>'+fmt(sas.utilidad)+'</b></div>';
    h += '<div class="pf-diag-row"><span>− Impuesto de renta de la SAS <span class="pf-mut">(35%)</span></span><b>−'+fmt(sas.impuestoRenta)+'</b></div>';
    h += '<div class="pf-diag-row"><span>Dividendos que te pasas <span class="pf-mut">('+sas.repartoPct+'%)</span></span><b>'+fmt(sas.dividendos)+'</b></div>';
    h += '<div class="pf-diag-row"><span>− Impuesto por dividendos <span class="pf-mut">(no gravados: 15% sobre lo que pasa de '+fmt(exento)+')</span></span><b>−'+fmt(sas.impuestoDividendos)+'</b></div>';
    h += '<div class="pf-diag-row"><span>− Impuesto de renta sobre tu sueldo</span><b>−'+fmt(sas.impuestoSalario)+'</b></div>';
    h += '<div class="pf-diag-out"><span>Total SAS Ordinario <span class="pf-mut">(impuestos + costos)</span></span><b>'+fmt(sas.total)+'</b></div>';
    // ── SAS · SIMPLE ──
    h += '<div class="pf-diag-sub" style="margin-top:14px">SAS en régimen Simple <span class="pf-mut">(tarifa plana sobre ingresos · Art. 908)</span></div>';
    if(!eligS.elegible){
      h += '<div class="pf-simple-adv" style="margin-top:2px"><strong>No aplicable:</strong> '+(eligS.motivos[0]||'')+'</div>';
    } else {
      h += '<div class="pf-diag-row"><span>Tus ingresos del año <span class="pf-mut">(sobre estos se calcula, sin restar costos)</span></span><b>'+fmt(sasS.ingresos)+'</b></div>';
      h += '<div class="pf-diag-row"><span>− Impuesto SIMPLE de la empresa <span class="pf-mut">('+pct(sasS.tarifa)+'% · '+(sasS.grupoNombre||'')+')</span></span><b>−'+fmt(sasS.impuestoSimple)+'</b></div>';
      h += '<div class="pf-diag-row"><span>Dividendos que te pasas <span class="pf-mut">('+sasS.repartoPct+'%)</span></span><b>'+fmt(sasS.dividendos)+'</b></div>';
      h += '<div class="pf-diag-row"><span>− Impuesto por dividendos <span class="pf-mut">(GRAVADOS: en Simple no son depurados)</span></span><b>−'+fmt(sasS.impuestoDividendos)+'</b></div>';
      h += '<div class="pf-diag-row"><span>− Impuesto de renta sobre tu sueldo</span><b>−'+fmt(sasS.impuestoSalario)+'</b></div>';
      h += '<div class="pf-diag-out"><span>Total SAS Simple <span class="pf-mut">(impuestos + costos)</span></span><b>'+fmt(sasS.total)+'</b></div>';
      h += '<p class="pf-note" style="margin-top:6px">En el Simple, las utilidades que te repartes <strong>no</strong> son dividendos depurados (Art. 48/49 no aplican), así que tributan como <strong>gravadas</strong> en tu cabeza. Si <strong>reinviertes</strong> (reparto 0%), el Simple suele ser mucho más barato; si te lo repartes todo, esa ventaja se reduce. La cifra del dividendo gravado es una estimación con las tarifas de tu config; <strong>valídala con tu contador</strong>.</p>';
    }
    // ── COMPARACIÓN a 3 ──
    const ops = [{k:'pn',nombre:'Como estás hoy',sub:'Persona natural',total:pn},{k:'ord',nombre:'SAS · Ordinario',sub:'renta 35%',total:sas.total}];
    if(eligS.elegible) ops.push({k:'simple',nombre:'SAS · Simple',sub:'tarifa plana',total:sasS.total});
    const ganador = ops.reduce((a,b)=> b.total<a.total?b:a);
    h += '<div class="pf-vs pf-vs-3" style="margin-top:14px">';
    ops.forEach(o=>{ h += '<div class="pf-vs-col'+(o.k===ganador.k?' win':'')+'">'+(o.k===ganador.k?'<span class="pf-vs-badge">Más barato</span>':'')+'<div class="pf-vs-name">'+o.nombre+'</div><div class="pf-vs-sub">'+o.sub+'</div><div class="pf-vs-total">'+fmt(o.total)+'</div></div>'; });
    h += '</div>';
    const difHoy = pn - ganador.total;
    h += '<div class="pf-diag-out"><span>'+(ganador.k==='pn' ? 'Quedándote como estás es lo más barato' : 'Lo más barato es '+ganador.nombre+'; frente a hoy ahorrarías')+'</span><b>'+(ganador.k==='pn'?'':fmt(Math.abs(difHoy)))+'</b></div>';
    return h;
  }

  function pfSasHtml(){
    const renta = pfRentaEstimada();
    if(renta.ingresos<=0) return '';
    const tipo = (state.profile && state.profile.tipoIngreso) || '';
    if(tipo === 'empleado'){
      let h = '<div class="pf-diag-card"><div class="pf-diag-t">¿Te conviene crear una empresa (SAS)?</div>';
      h += '<p class="pf-note" style="margin-top:0">Tus ingresos son un <strong>sueldo de la empresa donde trabajas</strong>, y ese sueldo no lo puedes pasar por una empresa propia: te lo paga tu empleador directamente. Por eso, crear una SAS no cambiaría tus impuestos en este caso.</p>';
      h += '<p class="pf-note">Este simulador aplica a quienes trabajan por su cuenta o tienen un negocio (honorarios, ventas, servicios). Si además del sueldo tienes ingresos por tu cuenta, ajústalo en tu perfil y te mostramos la comparación.</p></div>';
      return h;
    }
    const sas = pfSasEstimado();
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">¿Te conviene crear una empresa (SAS)?</div>';
    if(tipo === 'mixto') html += '<div class="pf-simple-adv" style="margin-top:0;margin-bottom:10px"><strong>Ojo:</strong> tienes sueldo como empleado y también ingresos por tu cuenta. Solo la parte que ganas <strong>por tu cuenta</strong> podría pasar por una SAS; el sueldo de tu empleo no. Toma esta simulación como una referencia sobre tu actividad independiente.</div>';
    html += '<p class="pf-note" style="margin-top:0">Simulación: si tus ingresos entraran por una empresa (SAS). Puedes pagarte una parte como <strong>sueldo</strong> y dejar el resto como <strong>utilidad</strong> (para repartir como dividendos o reinvertir). Comparamos los <strong>dos regímenes</strong> de la SAS: Ordinario (renta 35%) y Simple (tarifa plana). El régimen del Simple usa tu actividad elegida en "¿Ordinario o Simple?".</p>';
    html += '<div class="pf-grid2" style="margin-top:6px">';
    html += '<div class="pf-field"><label>Costos de tu negocio al año <span class="info-tip" data-def="sas_costos_negocio" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-sas-costos" inputmode="numeric" placeholder="0"></div></div>';
    html += '<div class="pf-field"><label>Sueldo que te pagas al año <span class="info-tip" data-def="sas_salario" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-sas-salario" inputmode="numeric" placeholder="0"></div></div>';
    html += '<div class="pf-field"><label>Costo de tener la SAS al año <span class="info-tip" data-def="sas_costos_sas" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-sas-mant" inputmode="numeric" placeholder="6.000.000"></div></div>';
    html += '</div>';
    html += '<div class="pf-opt-top" style="margin-top:10px"><span>¿Cuánto de la utilidad te pasas como dividendos? <span class="info-tip" data-def="sas_dividendos" tabindex="0">i</span></span><span class="pf-opt-val" id="pf-sas-repval">'+sas.repartoPct+'%</span></div>';
    html += '<input type="range" id="pf-sas-reparto" min="0" max="100" step="10" value="'+sas.repartoPct+'" class="pf-range">';
    html += '<div id="pf-sas-dyn">'+pfSasCompHtml()+'</div>';
    html += '<p class="pf-note">El sueldo baja el impuesto de la empresa, pero paga su propio impuesto y aportes; dejar utilidad paga 35% y, si la repartes, dividendos. Prueba distintos montos de sueldo y reparto. No incluye los aportes que paga la empresa sobre el sueldo'+(sas.requiereRevisor?' ni el revisor fiscal que necesitarías':'')+'; confírmalo con un contador.</p>';
    html += '<button class="pf-cta-mini" data-cta-asesor style="margin-top:4px">Quiero que me asesoren si crear una SAS</button>';
    html += '</div>';
    return html;
  }

  function abrirWhatsAppAsesor(tema){
    const num = '573104278004';
    const msg = encodeURIComponent('Hola, vengo de ABBA Patrimonial y quiero información sobre: '+((tema||'').replace(/\s+/g,' ').trim()));
    const url = 'https://wa.me/'+num+'?text='+msg;
    try {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch(e){
      try { window.open(url, '_blank'); } catch(e2){ window.location.href = url; }
    }
  }

  // Impuesto al patrimonio por la tabla marginal del art. 296-3 (en UVT).
  function aplicarTablaPatrimonio(baseGravablePesos){
    const tabla = ((fiscalConfig().impuestoPatrimonio)||{}).tabla || (FISCAL_DEFAULT.impuestoPatrimonio||{}).tabla || [];
    if(!tabla.length || baseGravablePesos<=0) return 0;
    const bUVT = baseGravablePesos / uvtValor();
    let r = tabla.find(x => bUVT > x.desde && (x.hasta==null || bUVT <= x.hasta));
    if(!r) r = tabla[tabla.length-1];
    return Math.round(Math.max(0, (bUVT - r.desde) * r.tarifa + (r.acumUVT||0)) * uvtValor());
  }
  function pfTotalDeudas(){ return (state.deudas||[]).reduce((s,d)=>s+(d.saldo||0),0); }
  // Gasto anual estimado (mensual registrado × 12) — sugerencia para "compras y consumos totales".
  function pfGastoAnualEstimado(){
    try{
      let mensual = 0; const gi = state.gastosItems || {};
      Object.keys(gi).forEach(k=>{ (gi[k]||[]).forEach(it=>{ if(!it.linkedToDeuda) mensual += (+it.monto||0); }); });
      return Math.round(mensual*12);
    }catch(e){ return 0; }
  }
  function pfImpuestoPatrimonio(){
    const cfg = (fiscalConfig().impuestoPatrimonio)||(FISCAL_DEFAULT.impuestoPatrimonio)||{};
    const bruto = pfPatrimonioBruto();
    const deudas = pfTotalDeudas();
    const liquido = Math.max(0, bruto - deudas);
    const vivienda = (state.fiscal.patrimonio && +state.fiscal.patrimonio.viviendaHabitacion) || 0;
    const exclusion = Math.min(vivienda, enPesos(cfg.exclusionViviendaUVT||12000));
    const baseGravable = Math.max(0, liquido - exclusion);
    const umbral = enPesos(cfg.umbralUVT||72000);
    const umbralTemp = enPesos(cfg.umbralTemporal2026UVT||40000);
    const obligado = liquido >= umbral;
    const enZonaTemporal = !obligado && liquido >= umbralTemp;   // entre 40.000 y 72.000 UVT
    const impuesto = obligado ? aplicarTablaPatrimonio(baseGravable) : 0;
    return { bruto, deudas, liquido, vivienda, exclusion, baseGravable, umbral, umbralTemp, obligado, enZonaTemporal, impuesto };
  }

  function pfPatrimonioResumen(){
    const r = pfImpuestoPatrimonio();
    let h = '';
    h += '<div class="pf-diag-row"><span>Patrimonio bruto <span class="pf-mut">(tu Mapa Patrimonial)</span></span><b>'+fmt(r.bruto)+'</b></div>';
    h += '<div class="pf-diag-row"><span>− Deudas <span class="pf-mut">(tus créditos)</span> <span class="info-tip" data-def="pat_deudas" tabindex="0">i</span></span><b>−'+fmt(r.deudas)+'</b></div>';
    h += '<div class="pf-diag-row pf-diag-strong"><span>= Patrimonio líquido</span><b>'+fmt(r.liquido)+'</b></div>';
    if(r.exclusion>0) h += '<div class="pf-diag-row"><span>− Exclusión vivienda de habitación <span class="pf-mut">(máx. 12.000 UVT)</span></span><b>−'+fmt(r.exclusion)+'</b></div>';
    h += '<div class="pf-diag-row"><span>Umbral para el impuesto <span class="pf-mut">(72.000 UVT)</span></span><b>'+fmt(r.umbral)+'</b></div>';
    if(r.obligado){
      h += '<div class="pf-diag-row pf-diag-strong"><span>Base gravable</span><b>'+fmt(r.baseGravable)+'</b></div>';
      h += '<div class="pf-diag-out"><span>Impuesto al patrimonio estimado</span><b>'+fmt(r.impuesto)+'</b></div>';
      h += '<div class="pf-note" style="margin-top:8px;color:var(--warn,#b45309)">Tu patrimonio líquido supera las 72.000 UVT: estás obligado a declarar y pagar el impuesto al patrimonio (Formulario 420). La 1ª cuota vence entre el 12 y el 26 de mayo de 2026 según tu NIT.</div>';
    } else if(r.enZonaTemporal){
      h += '<div class="pf-note" style="margin-top:8px;color:var(--warn,#b45309)">No superas el umbral permanente de 72.000 UVT ('+fmt(r.umbral)+'), pero sí las 40.000 UVT ('+fmt(r.umbralTemp)+'). Por el Decreto 1474 de 2025 (emergencia económica, solo 2026) <strong>podrías quedar obligado</strong>. Ese decreto está en revisión de la Corte Constitucional, así que confírmalo con tu contador antes de declarar.</div>';
    } else {
      h += '<div class="pf-note" style="margin-top:8px;color:var(--pos,#0e7c4a)">Tu patrimonio líquido está por debajo del umbral: por ahora <strong>no pagarías</strong> impuesto al patrimonio.</div>';
    }
    return h;
  }
  // ═══ MÓDULO 12 · PRESUPUESTO MENSUAL (Fase B) ═══
  function pgNombreMesCap(mesKey){ const n=pgNombreMes(mesKey); return n.charAt(0).toUpperCase()+n.slice(1); }
  function pgMesTieneDatos(mk){ return pgItemsFlat().some(it=>pgRegistrado(it.itemKey,mk)) || pgIngresoRegistrado(mk); }
  function pgAcumuladoAnio(anio){
    let ing=0, gas=0, estimado=false; const items=pgItemsFlat();
    pgMeses(anio).forEach(mk=>{
      ing += pgIngresoFiscalMes(mk); gas += pgTotFiscalGasto(mk);
      if(!pgIngresoRegistrado(mk)) estimado=true;
      items.forEach(it=>{ if(!pgRegistrado(it.itemKey,mk)) estimado=true; });
    });
    return {ing, gas, estimado};
  }
  // FASE D: ingreso del año para lo fiscal — suma los meses reales y cae al estimado en los que falten.
  function pgIngresoAnioFiscal(anio){ anio=anio||pgAnio(); let total=0, reales=0; pgMeses(anio).forEach(mk=>{ total+=pgIngresoFiscalMes(mk); if(pgIngresoRegistrado(mk)) reales++; }); return {total, reales, hayAlguno:reales>0}; }
  function pgStripHtml(anio, mesKey){
    const act=+mesKey.slice(5,7); let s='';
    for(let m=1;m<=12;m++){ const mk=pgMesKey(anio,m); const cls = m===act?'now':(pgMesTieneDatos(mk)?'done':(pgClaseMes(mk)==='pasado'?'past':'')); s+='<span class="'+cls+'"></span>'; }
    return s;
  }
  // Encabezado de categoría editable (renombrar, arrastrar, eliminar).
  function pgCatHeadHtml(c, ci, mesKey, conDisp){
    return '<div class="pg-cat-head">'
      + '<span class="pg-drag" draggable="true" data-dragcat="'+ci+'" title="Arrastrar categoría">⠿</span>'
      + '<input class="pg-est-catname" data-catid="'+c.id+'" value="'+escapeHtml(c.label||'')+'" placeholder="Categoría">'
      + '<button class="pg-est-del" data-delcat="'+c.id+'" title="Eliminar categoría">✕</button>'
      + '</div>';
  }
  function pgChip(v){ v=+v||0; return (v<0?'-$ ':'$ ')+fmtInput(Math.abs(v)); }
  function pgMesAbrev(mesKey){ const M=['','ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']; return M[+mesKey.slice(5,7)]||''; }
  function pgMetaBtnHtml(it, ik, mesKey){
    const meta=pgItemMeta(it); const open=pgMetaOpen(ik); let tag='';
    if(meta.tipo==='fecha'){ const v=pgMetaVinculada(it); if(v) tag='<span class="pg-meta-tag">'+escapeHtml((v.nombre||'meta').slice(0,16))+'</span>'; }
    else if(meta.tipo==='llenar' && +meta.tope>0) tag='<span class="pg-meta-tag">tope</span>';
    return '<button class="pg-metabtn'+(meta.tipo!=='mensual'?' set':'')+(open?' open':'')+'" data-metatoggle="'+ik+'" title="Configurar la meta de este rubro">'+SVG_TARGET+tag+'</button>';
  }
  function pgMetaProgHtml(acum, obj){ const pct=obj>0?Math.min(100,Math.round(Math.max(0,acum)/obj*100)):0; return '<div class="pg-meta-bar"><span style="width:'+pct+'%"></span></div><div class="pg-meta-progtxt">'+fmt(Math.max(0,acum))+' de '+fmt(obj)+' · '+pct+'%</div>'; }
  function pgMetaPanelHtml(it, ik, mesKey){
    const meta=pgItemMeta(it); const anio=pgAnio();
    const seg=(t,lbl)=>'<button class="pg-meta-seg'+(meta.tipo===t?' on':'')+'" data-metatipo="'+ik+'" data-tipo="'+t+'">'+lbl+'</button>';
    let h='<div class="pg-meta-cfg">';
    h+='<div class="pg-meta-hd"><span>Meta de este rubro</span><button class="pg-movs-hide" data-metatoggle="'+ik+'">Ocultar ▴</button></div>';
    h+='<div class="pg-meta-segs">'+seg('mensual','Mensual fija')+seg('fecha','Para una fecha')+seg('llenar','Hasta llenar')+'</div>';
    if(meta.tipo==='mensual'){
      h+='<div class="pg-meta-note">Asignas un monto fijo cada mes en la casilla <strong>Asignado</strong>; se trae solo del mes anterior.</div>';
    } else if(meta.tipo==='fecha'){
      const metas=pgMetasList();
      if(!metas.length){
        h+='<div class="pg-meta-note">No tienes metas creadas todavía. Ve al módulo <strong>Metas y proyección</strong>, crea una (ej. "Fondo de emergencia") con su objetivo y fecha, y vuelve aquí para programar el aporte mensual.</div>';
      } else {
        const v=pgMetaVinculada(it);
        h+='<label class="pg-meta-f pg-meta-fw"><span>Vincular con una meta de tu módulo de Metas</span><select class="pg-meta-ref" data-metaref="'+ik+'"><option value="">— Elige una meta —</option>'
          + metas.map(m=>'<option value="'+m.id+'"'+(v&&v.id===m.id?' selected':'')+'>'+escapeHtml(m.nombre||'(sin nombre)')+'</option>').join('')
          + '</select></label>';
        if(v){
          const saldo=pgMetaSaldoReal(v), obj=+v.objetivo||0;
          if(obj>0 && v.fecha){
            const per=pgMetaAportePorMes(it), falta=Math.max(0,obj-saldo);
            h+=pgMetaProgHtml(saldo, obj);
            h+='<div class="pg-meta-note">Objetivo <strong>'+fmt(obj)+'</strong> para <strong>'+pgMesAbrev(v.fecha)+' '+v.fecha.slice(0,4)+'</strong>. Saldo real hoy: '+fmt(saldo)+' (de tu módulo de Metas). Te falta '+fmt(falta)+' → aporte sugerido <strong>'+fmt(per)+'/mes</strong> en los meses que restan.</div>';
            h+='<button class="pg-meta-apply" data-metaapply="'+ik+'">Repartir el aporte en los meses que faltan</button>';
          } else {
            h+='<div class="pg-meta-note">La meta <strong>'+escapeHtml(v.nombre||'')+'</strong> aún no tiene objetivo o fecha. Complétalos en el módulo <strong>Metas y proyección</strong> y vuelve.</div>';
          }
        } else {
          h+='<div class="pg-meta-note">Elige arriba a qué meta va este rubro. El objetivo, la fecha y el saldo se toman de tu módulo de Metas — aquí solo programas el aporte mensual.</div>';
        }
      }
    } else {
      const room=pgMetaRoom(ik,it,mesKey), acum=pgMetaAcumPrev(ik,mesKey);
      h+='<div class="pg-meta-fields">'
        +'<label class="pg-meta-f"><span>Tope</span><div class="pf-inp pf-mono pg-meta-inp"><span class="pf-pre">$</span><input class="pg-meta-tope" data-metatope="'+ik+'" inputmode="numeric" value="'+(+meta.tope>0?fmtInput(meta.tope):'')+'" placeholder="0"></div></label>'
        +'</div>';
      if(+meta.tope>0){
        h+=pgMetaProgHtml(acum, +meta.tope);
        h+='<div class="pg-meta-note">Aporta lo que puedas cada mes en <strong>Asignado</strong>. Te queda <strong>'+fmt(room||0)+'</strong> para el tope; no te dejo pasarte.</div>';
      } else h+='<div class="pg-meta-note">Pon el tope (ej. el máximo deducible de tu pensión voluntaria o AFC).</div>';
    }
    h+='</div>';
    return h;
  }
  // Panel de MOVIMIENTOS reutilizable. scope = itemKey (gasto) o 'ING' (ingreso).
  function pgMovsPanelHtml(scope, movs){
    const hoy=pgHoyISO(); const esIng=(scope==='ING');
    const ph=esIng?'¿De dónde?':'¿En qué?'; const phAdd=esIng?'¿De dónde? (opcional)':'¿En qué? (opcional)';
    let h='<div class="pg-movs">';
    h+='<div class="pg-movs-hd"><span>Movimientos</span><button class="pg-movs-hide" data-movtoggle="'+scope+'">Ocultar ▴</button></div>';
    if(!movs.length) h+='<div class="pg-mov-empty">Aún no registras nada aquí. Agrega tu primer movimiento abajo — el total se suma solo.</div>';
    movs.forEach(m=>{
      h+='<div class="pg-mov">'
        + '<input type="date" class="pg-mov-fecha-inp" data-movscope="'+scope+'" data-movid="'+m.id+'" value="'+(m.fecha||hoy)+'">'
        + '<input class="pg-mov-nota" data-movscope="'+scope+'" data-movid="'+m.id+'" value="'+escapeHtml(m.nota||'')+'" placeholder="'+ph+'">'
        + '<div class="pf-inp pf-mono pg-mov-inp"><span class="pf-pre">$</span><input class="pg-mov-monto" data-movscope="'+scope+'" data-movid="'+m.id+'" inputmode="numeric" value="'+(m.monto?fmtInput(m.monto):'')+'" placeholder="0"></div>'
        + '<button class="pg-mov-del" data-movscope="'+scope+'" data-movid="'+m.id+'" title="Eliminar movimiento">'+SVG_X+'</button>'
        + '</div>';
    });
    h+='<div class="pg-mov pg-mov-add">'
      + '<input type="date" class="pg-mov-newfecha" data-movscope="'+scope+'" value="'+hoy+'">'
      + '<input class="pg-mov-newnota" data-movscope="'+scope+'" placeholder="'+phAdd+'">'
      + '<div class="pf-inp pf-mono pg-mov-inp"><span class="pf-pre">$</span><input class="pg-mov-newmonto" data-movscope="'+scope+'" inputmode="numeric" placeholder="0"></div>'
      + '<button class="pg-mov-addbtn" data-movscope="'+scope+'">Agregar</button>'
      + '</div>';
    if(movs.length) h+='<div class="pg-movs-tot"><span>Total registrado</span><strong>'+fmt(movs.reduce((s,m)=>s+(+m.monto||0),0))+'</strong></div>';
    h+='</div>';
    return h;
  }
  function pgItemHandleHtml(c, ii){ return '<span class="pg-drag pg-drag-sm" draggable="true" data-dragitem="'+ii+'" data-dragcatid="'+c.id+'" title="Arrastrar">⠿</span>'; }
  function pgItemNameInputHtml(c, it, ii){ const ik=pgItemKey(c.id,it.id); return '<input class="pg-est-itemname pg-row-name" data-itemkey="'+ik+'" value="'+escapeHtml(it.nombre||'')+'" placeholder="Gasto '+(ii+1)+'">'; }
  function pgAddCatBtnHtml(){ return '<div style="margin-top:8px"><button class="pf-cta-mini" id="pg-add-cat">+ Nueva categoría</button></div>'; }
  // Bloque de PRESUPUESTO (asignado + gastado + disponible), filas editables.
  function pgBudgetBlockHtml(mesKey, clase){
    let html='';
    const ingresoReg = pgIngresoRegistrado(mesKey);
    const bloqueo = (clase==='actual') && !ingresoReg;   // mes activo sin ingreso: primero registrar
    if(bloqueo){
      html += '<div class="pg-rta wait"><div class="pg-rta-l"><div class="t">Registra tu ingreso del mes</div><div class="s">Aún no registras cuánto te entró en '+pgNombreMes(mesKey)+'. Regístralo abajo para empezar a repartirlo entre tus gastos.</div></div><div class="pg-rta-amt">'+fmt(0)+'</div></div>';
    } else {
      const rta=pgListoParaAsignar(mesKey);
      const rtaCls = rta===0 ? 'zero' : (rta>0?'':'neg');
      const rtaMsg = rta>0 ? 'Tienes pesos sin asignar. Repártelos entre tus gastos hasta llegar a cero.' : (rta<0 ? 'Asignaste más de lo que ingresó. Bájale a algún gasto hasta llegar a cero.' : '¡Listo! Cada peso de tu ingreso tiene un destino.');
      html += '<div class="pg-rta '+rtaCls+'"><div class="pg-rta-l"><div class="t">Listo para asignar</div><div class="s">'+rtaMsg+'</div></div><div class="pg-rta-amt">'+fmt(rta)+'</div></div>';
    }
    const ingk = clase==='futuro' ? 'meta' : 'real';
    const ingMov = (ingk==='real');   // los movimientos aplican a lo real, no al plan futuro
    const ingHasM = ingMov && pgIngHasMovs(mesKey), ingMovs=pgIngMovs(mesKey), ingOpen = ingMov && pgMovOpen('ING');
    html += '<div class="pg-card"><div class="pg-inc"><div class="pg-inc-body"><div class="pg-inc-t">Ingreso '+(clase==='futuro'?'esperado de ':'de ')+pgNombreMes(mesKey)+'</div><div class="pg-inc-s">'+(clase==='futuro'?'Lo que planeas recibir; es lo que repartes abajo':'Lo que realmente te entró')+'</div></div>'
      + '<div class="pg-inc-r">'
      + (ingMov
          ? (ingHasM
              ? '<button class="pg-inc-sum" data-movtoggle="ING" title="Ver o editar registros">'+pgChip(pgIngMovsTotal(mesKey))+'<span class="pg-gc-n">'+ingMovs.length+'</span><span class="pg-gc-ch">'+(ingOpen?'▴':'▾')+'</span></button>'
              : '<button class="pg-inc-reg'+(ingOpen?' open':'')+'" data-movtoggle="ING" title="Registrar lo que te entró (concepto, monto y fecha)">Registrar<span class="pg-gc-ch">'+(ingOpen?'▴':'▾')+'</span></button>')
          : '<div class="pf-inp pf-mono pg-inc-inp"><span class="pf-pre">$</span><input type="text" id="pg-ing" data-ingk="'+ingk+'" inputmode="numeric" placeholder="0"></div>')
      + '</div></div>'
      + (ingOpen ? pgMovsPanelHtml('ING', ingMovs) : '')
      + '</div>';
    html += '<div class="pg-card"><div class="pf-diag-t" style="margin-bottom:4px">Reparte tu ingreso · '+pgNombreMes(mesKey)+'</div>'
      + '<p class="pf-note" style="margin-top:0">En <strong>Asignado</strong> escribes cuánto le das a cada gasto (cada mes se <strong>trae solo lo del anterior</strong>, marcado con ↩). Lo <strong>Gastado</strong> se registra tocando el botón <em>Registrar</em> del gasto y anotando cada compra con su fecha; el total se suma solo. Renombra tocando el nombre, arrastra con ⠿ para reordenar, y usa "+ gasto" o "+ Nueva categoría".</p>';
    const cats=pgCategorias();
    cats.forEach((c,ci)=>{
      html += '<div class="pg-cat pg-est-cat" data-catidx="'+ci+'">'+pgCatHeadHtml(c, ci, mesKey, false);
      html += '<div class="pg-cat-items">';
      const canMov = clase!=='futuro';   // los movimientos son gastos reales; en meses futuros no aplican
      (c.items||[]).forEach((it,ii)=>{
        const ik=pgItemKey(c.id,it.id);
        const asig=pgAsignado(ik,mesKey), gast=pgGastadoMes(ik,mesKey), disp=pgDisponible(ik,mesKey);
        const heredado=pgAsignadoHeredado(ik,mesKey);
        const pct = asig>0 ? Math.min(100, Math.round(gast/asig*100)) : 0;
        const over = gast>asig && asig>0; const availCls = disp<0?'over':(disp===0?'zero':'ok');
        const movs=pgMovs(ik,mesKey), hasM=movs.length>0, open=canMov && pgMovOpen(ik);
        const gastCell = canMov
          ? '<div class="pg-col"><div class="l">Gastado</div><button class="pg-gasto'+(hasM?' has':' empty')+(open?' open':'')+'" data-movtoggle="'+ik+'" title="Registrar lo gastado por movimientos">'+(hasM?pgChip(gast)+'<span class="pg-gc-n">'+movs.length+'</span>':'Registrar')+'<span class="pg-gc-ch">'+(open?'▴':'▾')+'</span></button></div>'
          : '<div class="pg-col"><div class="l">Gastado</div><span class="pg-avail zero">—</span></div>';
        html += '<div class="pg-row pg-est-item" data-catid="'+c.id+'" data-itemidx="'+ii+'"><div class="pg-row-top pg-row-edit">'
          + pgItemHandleHtml(c,ii) + pgItemNameInputHtml(c,it,ii) + pgMetaBtnHtml(it, ik, mesKey)
          + '<div class="pg-col"><div class="l">Asignado'+(heredado?' <span class="pg-heredado-tag" title="Se trae del mes anterior; edítalo si presupuestas distinto">↩</span>':'')+'</div><div class="pf-inp pf-mono pg-asig-box"><span class="pf-pre">$</span><input class="pg-inp'+(heredado?' pg-carried':'')+'" data-item="'+ik+'" data-k="meta" inputmode="numeric" value="'+(asig>0?fmtInput(asig):'')+'" placeholder="0"></div></div>'
          + gastCell
          + '<div class="pg-col"><div class="l">Disponible</div><span class="pg-avail '+availCls+'">'+pgChip(disp)+'</span></div>'
          + '<button class="pg-est-del pg-row-del" data-delitem="'+ik+'" title="Eliminar gasto">✕</button>'
          + '</div><div class="pg-bar"><span class="'+(over?'over':'')+'" style="width:'+pct+'%"></span></div>'
          + (pgMetaOpen(ik) ? pgMetaPanelHtml(it, ik, mesKey) : '')
          + (open ? pgMovsPanelHtml(ik, movs) : '')
          + '</div>';
      });
      html += '<button class="pg-est-add" data-additem="'+c.id+'">+ gasto</button>';
      html += '</div></div>';
    });
    html += pgAddCatBtnHtml();
    html += '</div>';
    return html;
  }
  // Bloque de REGISTRO de lo real (meses pasados o modo básico), filas editables.
  function pgActualsBlockHtml(mesKey, clase){
    let html='';
    const titulo = clase==='pasado' ? ('Registra lo que pasó en '+pgNombreMes(mesKey)) : ('Registra lo real de '+pgNombreMes(mesKey));
    html += '<div class="pg-card"><div class="pf-diag-t">'+titulo+'</div>';
    html += '<p class="pf-note" style="margin-top:0">'+(clase==='pasado'?'Este mes ya pasó: no se presupuesta, se registra.':'Registra lo que llevas del mes.')+' Toca <em>Registrar</em> en cada gasto y anota cada compra con su fecha; el total se suma solo. Renombra, arrastra con ⠿ o agrega gastos aquí mismo.</p>';
    const aIngHasM=pgIngHasMovs(mesKey), aIngMovs=pgIngMovs(mesKey), aIngOpen=pgMovOpen('ING');
    html += '<div class="pg-inc" style="margin:4px 0 12px"><div class="pg-inc-body"><div class="pg-inc-t">Ingreso de '+pgNombreMes(mesKey)+'</div><div class="pg-inc-s">Lo que realmente te entró</div></div>'
      + '<div class="pg-inc-r">'
      + (aIngHasM
          ? '<button class="pg-inc-sum" data-movtoggle="ING" title="Ver o editar registros">'+pgChip(pgIngMovsTotal(mesKey))+'<span class="pg-gc-n">'+aIngMovs.length+'</span><span class="pg-gc-ch">'+(aIngOpen?'▴':'▾')+'</span></button>'
          : '<button class="pg-inc-reg'+(aIngOpen?' open':'')+'" data-movtoggle="ING" title="Registrar lo que te entró (concepto, monto y fecha)">Registrar<span class="pg-gc-ch">'+(aIngOpen?'▴':'▾')+'</span></button>')
      + '</div></div>'
      + (aIngOpen ? pgMovsPanelHtml('ING', aIngMovs) : '');
    const cats=pgCategorias();
    cats.forEach((c,ci)=>{
      html += '<div class="pg-cat pg-est-cat" data-catidx="'+ci+'">'+pgCatHeadHtml(c, ci, mesKey, false);
      html += '<div class="pg-cat-items">';
      (c.items||[]).forEach((it,ii)=>{
        const ik=pgItemKey(c.id,it.id);
        const movs=pgMovs(ik,mesKey), hasM=movs.length>0, open=pgMovOpen(ik);
        const est=fmtInput(it.montoTipico);
        const gastCell = hasM
          ? '<div class="pg-col"><div class="l">Gastado real</div><button class="pg-gasto has'+(open?' open':'')+'" data-movtoggle="'+ik+'" title="Ver o editar movimientos">'+pgChip(pgGastadoMes(ik,mesKey))+'<span class="pg-gc-n">'+movs.length+'</span><span class="pg-gc-ch">'+(open?'▴':'▾')+'</span></button></div>'
          : '<div class="pg-col"><div class="l">Gastado real</div><button class="pg-gasto empty'+(open?' open':'')+'" data-movtoggle="'+ik+'" title="Sin registrar; si lo dejas así se estima en $'+est+'">Registrar<span class="pg-gc-ch">'+(open?'▴':'▾')+'</span></button></div>';
        html += '<div class="pg-row pg-est-item" data-catid="'+c.id+'" data-itemidx="'+ii+'"><div class="pg-row-top pg-row-edit">'
          + pgItemHandleHtml(c,ii) + pgItemNameInputHtml(c,it,ii)
          + gastCell
          + '<button class="pg-est-del pg-row-del" data-delitem="'+ik+'" title="Eliminar gasto">✕</button>'
          + '</div>'
          + (open ? pgMovsPanelHtml(ik, movs) : '')
          + '</div>';
      });
      html += '<button class="pg-est-add" data-additem="'+c.id+'">+ gasto</button>';
      html += '</div></div>';
    });
    html += pgAddCatBtnHtml();
    html += '</div>';
    return html;
  }
  function renderPresupuesto(){
    const cont=document.getElementById('pg-screen'); if(!cont) return;
    const p=pgState(); const anio=pgAnio(); const mesKey=pgMesActivo(); const modo=pgModo(); const clase=pgClaseMes(mesKey);
    let html='';
    // Controles
    html += '<div class="pg-card"><div class="pg-controls">';
    html += '<div class="pf-field"><label>Modo</label><div class="pf-inp"><select id="pg-modo"><option value="basico"'+(modo!=='activo'?' selected':'')+'>Básico (solo registro fiscal)</option><option value="activo"'+(modo==='activo'?' selected':'')+'>Presupuesto activo</option></select></div></div>';
    html += '<div class="pf-field"><label>Año gravable</label><div class="pf-inp"><select id="pg-anio">'+[2024,2025,2026,2027].map(y=>'<option value="'+y+'"'+(anio===y?' selected':'')+'>'+y+'</option>').join('')+'</select></div></div>';
    html += '</div></div>';
    // Navegador de mes
    const claseTag = clase==='pasado'?'· mes pasado':(clase==='actual'?'· mes actual':'· mes futuro');
    html += '<div class="pg-card"><div class="pg-monthnav">'
      + '<button class="pg-navbtn" id="pg-prev" aria-label="Mes anterior">‹</button>'
      + '<div class="pg-mlabel"><div class="m">'+pgNombreMesCap(mesKey)+'</div><div class="y">'+anio+' '+claseTag+'</div></div>'
      + '<button class="pg-navbtn" id="pg-next" aria-label="Mes siguiente">›</button></div>'
      + '<div class="pg-strip">'+pgStripHtml(anio,mesKey)+'</div>'
      + '<div class="pg-strip-cap">Presupuestas desde '+pgNombreMes(pgMesInicio())+'; los meses anteriores se registran.</div></div>';

    if(clase==='pasado'){
      html += pgActualsBlockHtml(mesKey, 'pasado');
    } else if(modo!=='activo'){
      // MODO BÁSICO: registro simple mes a mes (sin asignar).
      if(clase==='futuro'){
        html += '<div class="pg-card"><div class="pf-diag-t">'+pgNombreMesCap(mesKey)+' aún no llega</div><p class="pf-note" style="margin-top:0">En modo básico solo registras lo que ya pasó. Cuando este mes avance, aquí anotas —de forma sencilla— lo que ingresaste y gastaste, y tu Diagnóstico fiscal se mantiene exacto. Si prefieres <em>planear</em> los meses que vienen, cambia a "Presupuesto activo" arriba.</p></div>';
      } else {
        html += pgActualsBlockHtml(mesKey, 'actual');
      }
    } else {
      // MODO ACTIVO: presupuestar (mes actual/futuro).
      html += pgBudgetBlockHtml(mesKey, clase);
    }

    // Resumen del año gravable (fiscal)
    const bud=pgIngresoAnioFiscal(anio); const ingEst=bud.reales<12;
    html += '<div class="pg-card"><div class="pf-diag-t">Ingreso del año gravable '+anio+'</div>'
      + '<p class="pf-note" style="margin-top:0">'+(ingEst?'Suma tus meses registrados ('+bud.reales+'/12) y estima el resto con tu cifra mensual del Módulo 1.':'Los 12 meses registrados: cifra real, base exacta de tu declaración '+anio+'.')+'</p>'
      + '<div class="pg-yg pg-yg-solo"><div class="yg"><div class="l">Ingresos del año</div><div class="v inc">'+fmt(bud.total)+'</div></div></div>'
      + '<p class="pf-note">'+(ingEst?'<strong>Estimado.</strong> ':'<strong>Real. </strong>')+'Esta es la base de ingreso que alimenta tu renta, mes a mes y no como promedio anualizado.</p></div>';
    cont.innerHTML = html;
    pgWireScreen();
  }
  function pgWireScreen(){
    const p=pgState();
    const rerender=()=>{ scheduleSave('presupuesto'); renderPresupuesto(); };
    const modoSel=document.getElementById('pg-modo');
    if(modoSel) modoSel.addEventListener('change', function(){ p.modo=this.value; if(p.modo==='activo') pgMesInicio(); rerender(); });
    const anioSel=document.getElementById('pg-anio');
    if(anioSel) anioSel.addEventListener('change', function(){ p.anioGravable=+this.value; const h=pgHoy(); p.mesActivo = (h.slice(0,4)==String(p.anioGravable)) ? h : pgMesKey(p.anioGravable,1); rerender(); });
    const prev=document.getElementById('pg-prev'), next=document.getElementById('pg-next');
    const mover=(d)=>{ let m=+p.mesActivo.slice(5,7)+d; if(m<1)m=12; if(m>12)m=1; p.mesActivo=pgMesKey(p.anioGravable,m); rerender(); };
    if(prev) prev.addEventListener('click', ()=>mover(-1));
    if(next) next.addEventListener('click', ()=>mover(1));
    const activar=document.getElementById('pg-activar');
    if(activar) activar.addEventListener('click', ()=>{ p.modo='activo'; pgMesInicio(); rerender(); });
    // Editor de estructura del presupuesto (independiente del Módulo 1).
    const saveStruct=()=>{ scheduleSave('presupuesto'); };
    document.querySelectorAll('.pg-est-catname').forEach(inp=>{
      inp.addEventListener('input', function(){ pgRenameCat(this.dataset.catid, this.value); saveStruct(); });
    });
    document.querySelectorAll('.pg-est-itemname').forEach(inp=>{
      inp.addEventListener('input', function(){ pgRenameItem(this.dataset.itemkey, this.value); saveStruct(); });
    });
    document.querySelectorAll('[data-delcat]').forEach(b=>{ b.addEventListener('click', ()=>{ pgDelCat(b.dataset.delcat); rerender(); }); });
    document.querySelectorAll('[data-delitem]').forEach(b=>{ b.addEventListener('click', ()=>{ pgDelItem(b.dataset.delitem); rerender(); }); });
    document.querySelectorAll('[data-additem]').forEach(b=>{ b.addEventListener('click', ()=>{ pgAddItem(b.dataset.additem); rerender(); }); });
    const addCat=document.getElementById('pg-add-cat');
    if(addCat) addCat.addEventListener('click', ()=>{ pgAddCat(); rerender(); });
    // Arrastre de categorías e ítems (desde el asa ⠿, para no interferir con los inputs).
    (function(){
      let drag=null;
      document.querySelectorAll('.pg-drag[data-dragcat]').forEach(h=>{
        h.addEventListener('dragstart', e=>{ drag={tipo:'cat', catIdx:+h.dataset.dragcat}; e.dataTransfer.effectAllowed='move'; try{e.dataTransfer.setData('text','')}catch(_){}; });
      });
      document.querySelectorAll('.pg-drag[data-dragitem]').forEach(h=>{
        h.addEventListener('dragstart', e=>{ e.stopPropagation(); drag={tipo:'item', catId:h.dataset.dragcatid, itemIdx:+h.dataset.dragitem}; e.dataTransfer.effectAllowed='move'; try{e.dataTransfer.setData('text','')}catch(_){}; });
      });
      document.querySelectorAll('.pg-est-cat').forEach(el=>{
        el.addEventListener('dragover', e=>{ if(drag&&drag.tipo==='cat'){ e.preventDefault(); el.classList.add('dragover'); } });
        el.addEventListener('dragleave', ()=>{ el.classList.remove('dragover'); });
        el.addEventListener('drop', e=>{ if(drag&&drag.tipo==='cat'){ e.preventDefault(); el.classList.remove('dragover'); pgMoveCat(drag.catIdx, +el.dataset.catidx); drag=null; rerender(); } });
      });
      document.querySelectorAll('.pg-est-item').forEach(el=>{
        el.addEventListener('dragover', e=>{ if(drag&&drag.tipo==='item'&&drag.catId===el.dataset.catid){ e.preventDefault(); } });
        el.addEventListener('drop', e=>{ if(drag&&drag.tipo==='item'&&drag.catId===el.dataset.catid){ e.preventDefault(); e.stopPropagation(); pgMoveItem(drag.catId, drag.itemIdx, +el.dataset.itemidx); drag=null; rerender(); } });
      });
    })();
    const mesKey=pgMesActivo();
    const ing=document.getElementById('pg-ing');
    if(ing){
      const ingk=ing.dataset.ingk||'real';
      const cur = ingk==='meta' ? (pgIngresoCell(mesKey).meta||0) : pgIngresoRealRaw(mesKey);
      ing.value = (cur!=null && cur>0)?fmtInput(cur):''; attachMoneyInput(ing);
      ing.addEventListener('blur', function(){ const v=this.value.trim()===''?null:n(this.value); if(ingk==='meta') pgIngresoCell(mesKey).meta=(v||0); else pgSetIngresoReal(mesKey, v); rerender(); });
      ing.addEventListener('keydown', function(e){ if(e.key==='Enter') this.blur(); });
    }
    document.querySelectorAll('.pg-inp').forEach(inp=>{
      attachMoneyInput(inp);
      inp.addEventListener('focus', function(){ this.value = n(this.value)||''; });
      inp.addEventListener('blur', function(){
        const ik=this.dataset.item, k=this.dataset.k;
        if(k==='meta'){
          let v = this.value.trim()==='' ? 0 : n(this.value);
          const it=pgFindItem(ik); const meta=it?pgItemMeta(it):null;
          if(meta && meta.tipo==='llenar' && +meta.tope>0){ const room=pgMetaRoom(ik,it,mesKey); if(room!=null && v>room) v=room; }
          // Solo se fija explícito si cambia respecto a lo efectivo (heredado); si no, se mantiene la herencia.
          if(v !== pgAsignado(ik, mesKey)) pgSetAsignado(ik, mesKey, v);
        } else {
          const v = this.value.trim()==='' ? null : n(this.value);
          pgSetReal(ik, mesKey, v);
        }
        rerender();
      });
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter') this.blur(); });
    });
    // ── MOVIMIENTOS (desglose por transacciones) ──────────────────────────────
    const isIng = s => s==='ING';
    // Abrir / cerrar el desglose de un gasto o del ingreso.
    document.querySelectorAll('[data-movtoggle]').forEach(b=>{
      b.addEventListener('click', ()=>{ pgToggleMov(b.dataset.movtoggle); renderPresupuesto(); });
    });
    // Agregar un movimiento.
    document.querySelectorAll('.pg-mov-addbtn').forEach(b=>{
      b.addEventListener('click', ()=>{
        const scope=b.dataset.movscope, wrap=b.closest('.pg-mov-add');
        const montoEl=wrap.querySelector('.pg-mov-newmonto'), notaEl=wrap.querySelector('.pg-mov-newnota'), fechaEl=wrap.querySelector('.pg-mov-newfecha');
        const monto=n(montoEl?montoEl.value:0);
        if(monto<=0){ if(montoEl) montoEl.focus(); return; }
        const nota=notaEl?notaEl.value:'', fecha=fechaEl?fechaEl.value:'';
        if(isIng(scope)) pgAddIngMov(mesKey, monto, nota, fecha); else pgAddMov(scope, mesKey, monto, nota, fecha);
        pgOpenMovs[scope]=true; rerender();
      });
    });
    document.querySelectorAll('.pg-mov-newmonto').forEach(inp=>{
      attachMoneyInput(inp);
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter'){ const btn=this.closest('.pg-mov-add').querySelector('.pg-mov-addbtn'); if(btn) btn.click(); } });
    });
    document.querySelectorAll('.pg-mov-newnota').forEach(inp=>{
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter'){ const m=this.closest('.pg-mov-add').querySelector('.pg-mov-newmonto'); if(m) m.focus(); } });
    });
    // Editar fecha de un movimiento (nuevo o existente).
    document.querySelectorAll('.pg-mov-fecha-inp').forEach(inp=>{
      inp.addEventListener('change', function(){ const s=this.dataset.movscope, id=this.dataset.movid; if(isIng(s)) pgSetIngMovFecha(mesKey,id,this.value); else pgSetMovFecha(s,mesKey,id,this.value); pgOpenMovs[s]=true; scheduleSave('presupuesto'); });
    });
    // Eliminar un movimiento.
    document.querySelectorAll('.pg-mov-del').forEach(b=>{
      b.addEventListener('click', ()=>{ const s=b.dataset.movscope; if(isIng(s)) pgDelIngMov(mesKey,b.dataset.movid); else pgDelMov(s,mesKey,b.dataset.movid); pgOpenMovs[s]=true; rerender(); });
    });
    // Editar monto de un movimiento existente.
    document.querySelectorAll('.pg-mov-monto').forEach(inp=>{
      attachMoneyInput(inp);
      inp.addEventListener('blur', function(){ const s=this.dataset.movscope, id=this.dataset.movid, v=n(this.value); if(isIng(s)) pgSetIngMovMonto(mesKey,id,v); else pgSetMovMonto(s,mesKey,id,v); pgOpenMovs[s]=true; rerender(); });
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter') this.blur(); });
    });
    // Editar concepto (no cambia totales; solo guarda).
    document.querySelectorAll('.pg-mov-nota').forEach(inp=>{
      inp.addEventListener('blur', function(){ const s=this.dataset.movscope, id=this.dataset.movid; if(isIng(s)) pgSetIngMovNota(mesKey,id,this.value); else pgSetMovNota(s,mesKey,id,this.value); scheduleSave('presupuesto'); });
    });
    // ── FASE C · Metas por rubro ──────────────────────────────────────────────
    document.querySelectorAll('[data-metatoggle]').forEach(b=>{
      b.addEventListener('click', ()=>{ pgToggleMeta(b.dataset.metatoggle); renderPresupuesto(); });
    });
    document.querySelectorAll('[data-metatipo]').forEach(b=>{
      b.addEventListener('click', ()=>{ const ik=b.dataset.metatipo, it=pgFindItem(ik); if(it) pgItemMeta(it).tipo=b.dataset.tipo; pgOpenMeta[ik]=true; rerender(); });
    });
    document.querySelectorAll('.pg-meta-ref').forEach(sel=>{
      sel.addEventListener('change', function(){ const ik=this.dataset.metaref, it=pgFindItem(ik); if(it) pgItemMeta(it).metaRef=this.value||null; pgOpenMeta[ik]=true; rerender(); });
    });
    document.querySelectorAll('.pg-meta-tope').forEach(inp=>{
      attachMoneyInput(inp);
      inp.addEventListener('blur', function(){ const ik=this.dataset.metatope, it=pgFindItem(ik); if(it) pgItemMeta(it).tope=Math.max(0,n(this.value)); pgOpenMeta[ik]=true; rerender(); });
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter') this.blur(); });
    });
    document.querySelectorAll('.pg-meta-apply').forEach(b=>{
      b.addEventListener('click', ()=>{ const ik=b.dataset.metaapply, it=pgFindItem(ik); if(it) pgDistribuirMetaFecha(ik, it); pgOpenMeta[ik]=true; rerender(); });
    });
  }

  function pfPatrimonioHtml(){
    const p = (state.fiscal.patrimonio)||{};
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">Impuesto al patrimonio</div>';
    html += '<p class="pf-note" style="margin-top:0">Es un impuesto <strong>distinto</strong> a la declaración de renta: solo lo pagan los patrimonios grandes. Se calcula sobre tu <strong>patrimonio líquido</strong> (lo que tienes menos lo que debes) al 1 de enero, y solo aplica si supera 72.000 UVT (unos $3.771 millones).</p>';
    html += '<div class="pf-field" style="margin-top:6px"><label>Valor de tu vivienda de habitación <span class="info-tip" data-def="pat_vivienda" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-pat-viv" inputmode="numeric" placeholder="0"></div></div>';
    html += '<div id="pf-pat-out" style="margin-top:10px">'+pfPatrimonioResumen()+'</div>';
    html += '<p class="pf-note">El patrimonio bruto y las deudas se toman de tu Mapa Patrimonial y de tus créditos. <strong>Ojo con las deudas:</strong> ante la DIAN solo cuentan las que tengan soporte. Un crédito bancario se prueba con el extracto; pero un préstamo con un particular o familiar solo se acepta si está documentado con fecha cierta (un pagaré o contrato autenticado en notaría) o si quien te prestó declara esa cuenta por cobrar. Una deuda familiar informal que la DIAN rechace sube tu patrimonio gravable y puede incluso tratarse como donación. La exclusión aplica solo a tu vivienda de habitación. Tarifas marginales 0,5% / 1% / 1,5% (la de 1,5% solo hasta 2026). Estimación de planeación; la liquidación la valida tu contador.</p>';
    html += '<button class="pf-cta-mini" data-cta-asesor style="margin-top:4px">Quiero asesoría para mi impuesto al patrimonio</button>';
    html += '</div>';
    return html;
  }

  function pfHerenciaEstimado(){
    const goc = fiscalConfig().gananciaOcasional || FISCAL_DEFAULT.gananciaOcasional || {};
    const cfg = goc.herencia || (FISCAL_DEFAULT.gananciaOcasional||{}).herencia || {};
    const h = (state.fiscal && state.fiscal.herencia) || {};
    const tarifa = goc.tarifa || 0.15;
    const N = Math.max(1, +h.numHerederos || 1);
    const vivienda = +h.vivienda || 0;
    const otrosInm = +h.otrosInmuebles || 0;
    const otrosBienes = +h.otrosBienes || 0;
    const seguro = +h.seguroVida || 0;
    const esLeg = h.esLegitimario !== false;
    const totalRecibido = vivienda + otrosInm + otrosBienes + seguro;
    // Exenciones sobre inmuebles del causante (se reparten entre los herederos que los reciben)
    const exViv = Math.min(vivienda, enPesos(cfg.viviendaCausanteUVT||13000) / N);
    const exOtrosInm = Math.min(otrosInm, enPesos(cfg.otrosInmueblesCausanteUVT||6500) / N);
    // Seguro de vida (art. 303-1) — por beneficiario, aparte
    const exSeguro = Math.min(seguro, enPesos(cfg.seguroVidaUVT||3250));
    // Base de la herencia (bienes) antes de la exención personal
    const totalHerenciaBienes = vivienda + otrosInm + otrosBienes;
    const baseBienes = Math.max(0, (vivienda - exViv) + (otrosInm - exOtrosInm) + otrosBienes);
    // Exención personal: num 3 (legitimario/cónyuge) o num 4 (20%)
    let exPersonal = 0;
    if(esLeg){
      exPersonal = Math.min(baseBienes, enPesos(cfg.porBeneficiarioUVT||3250));
    } else {
      exPersonal = Math.min(baseBienes, Math.round((cfg.noLegitimarioPct||0.20)*totalHerenciaBienes), enPesos(cfg.noLegitimarioTopeUVT||1625));
    }
    const baseHerencia = Math.max(0, baseBienes - exPersonal);
    const baseSeguro = Math.max(0, seguro - exSeguro);
    const baseGravable = baseHerencia + baseSeguro;
    const impuesto = Math.round(baseGravable * tarifa);
    const totalExento = exViv + exOtrosInm + exSeguro + exPersonal;
    return { totalRecibido, exViv, exOtrosInm, exSeguro, exPersonal, esLeg, baseGravable, impuesto, totalExento, tarifa, tieneDatos: totalRecibido>0 };
  }
  function pfHerenciaResumen(){
    const r = pfHerenciaEstimado();
    if(!r.tieneDatos) return '<div class="pf-note" style="margin:0">Escribe los valores que recibes y calculamos tu impuesto con las exenciones que te aplican.</div>';
    let h = '';
    h += '<div class="pf-diag-row"><span>Total que recibes</span><b>'+fmt(r.totalRecibido)+'</b></div>';
    if(r.exViv>0) h += '<div class="pf-diag-row"><span>− Exención vivienda del causante <span class="pf-mut">(13.000 UVT ÷ herederos)</span></span><b>−'+fmt(r.exViv)+'</b></div>';
    if(r.exOtrosInm>0) h += '<div class="pf-diag-row"><span>− Exención otros inmuebles <span class="pf-mut">(6.500 UVT ÷ herederos)</span></span><b>−'+fmt(r.exOtrosInm)+'</b></div>';
    if(r.exSeguro>0) h += '<div class="pf-diag-row"><span>− Exención por seguro de vida <span class="pf-mut">(3.250 UVT)</span></span><b>−'+fmt(r.exSeguro)+'</b></div>';
    if(r.exPersonal>0) h += '<div class="pf-diag-row"><span>− Exención personal <span class="pf-mut">('+(r.esLeg?'3.250 UVT por ser familiar directo':'20%, tope 1.625 UVT')+')</span></span><b>−'+fmt(r.exPersonal)+'</b></div>';
    h += '<div class="pf-diag-row pf-diag-strong"><span>= Sobre esto se paga impuesto</span><b>'+fmt(r.baseGravable)+'</b></div>';
    h += '<div class="pf-diag-out"><span>Impuesto de ganancia ocasional <span class="pf-mut">('+Math.round(r.tarifa*100)+'%)</span></span><b>'+fmt(r.impuesto)+'</b></div>';
    if(r.impuesto===0) h += '<div class="pf-note" style="margin-top:8px;color:var(--pos,#0e7c4a)">Con las exenciones que te aplican, esta herencia <strong>no pagaría impuesto</strong> de ganancia ocasional.</div>';
    return h;
  }
  function pfHerenciaHtml(){
    const h = state.fiscal.herencia || {};
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">¿Vas a recibir una herencia? Calcula el impuesto</div>';
    html += '<p class="pf-note" style="margin-top:0">Recibir una herencia paga <strong>ganancia ocasional</strong> (15%), pero la ley exonera montos importantes. Escribe lo que te corresponde <strong>a ti</strong> y te decimos si pagarías algo. Si no esperas una herencia, deja todo en cero.</p>';
    html += '<div class="pf-grid2" style="margin-top:6px">';
    html += '<div class="pf-field"><label>Vivienda donde vivía la persona fallecida <span class="info-tip" data-def="her_vivienda" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-her-viv" inputmode="numeric" placeholder="0"></div></div>';
    html += '<div class="pf-field"><label>Otros inmuebles que heredas <span class="info-tip" data-def="her_otros_inm" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-her-oinm" inputmode="numeric" placeholder="0"></div></div>';
    html += '<div class="pf-field"><label>Otros bienes (dinero, carro, inversiones) <span class="info-tip" data-def="her_otros_bienes" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-her-obien" inputmode="numeric" placeholder="0"></div></div>';
    html += '<div class="pf-field"><label>Seguro de vida que recibes <span class="info-tip" data-def="her_seguro" tabindex="0">i</span></label><div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" id="pf-her-seg" inputmode="numeric" placeholder="0"></div></div>';
    html += '</div>';
    html += '<div class="pf-grid2" style="margin-top:6px">';
    html += '<div class="pf-field"><label>¿Entre cuántos se reparten los inmuebles? <span class="info-tip" data-def="her_herederos" tabindex="0">i</span></label><div class="pf-inp"><input type="text" id="pf-her-num" inputmode="numeric" placeholder="1"></div></div>';
    html += '<div class="pf-field"><label>¿Eres hijo/a, cónyuge o padre/madre? <span class="info-tip" data-def="her_legitimario" tabindex="0">i</span></label><div class="pf-inp"><select id="pf-her-leg"><option value="si"'+(h.esLegitimario!==false?' selected':'')+'>Sí</option><option value="no"'+(h.esLegitimario===false?' selected':'')+'>No</option></select></div></div>';
    html += '</div>';
    html += '<div id="pf-her-out" style="margin-top:10px">'+pfHerenciaResumen()+'</div>';
    html += '<p class="pf-note">Estimación con las exenciones del art. 307 y 303-1 (Ley 2277/2022). La exención de la vivienda del causante se reparte entre los herederos que la reciben; la personal aplica a cada uno. Un consejo clave: si la sucesión vende la vivienda y reparte el dinero, se puede perder la exención de la vivienda; conviene adjudicar el bien primero. Confírmalo con tu contador.</p>';
    html += '<button class="pf-cta-mini" data-cta-asesor style="margin-top:4px">Quiero asesoría para mi sucesión</button>';
    html += '</div>';
    return html;
  }

  function pfFechaLarga(iso){
    if(!iso) return '';
    const meses=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const p = String(iso).split('-'); return parseInt(p[2],10)+' de '+meses[parseInt(p[1],10)-1]+' de '+p[0];
  }
  function pfRentaVencimiento(){
    const cal = (fiscalConfig().calendario)||(FISCAL_DEFAULT.calendario)||{};
    const tabla = (cal.rentaPN && cal.rentaPN.length) ? cal.rentaPN : ((FISCAL_DEFAULT.calendario||{}).rentaPN||[]);
    if(!tabla.length) return null;
    const raw = ((state.fiscal&&state.fiscal.digitosCedula)||(state.fiscal&&state.fiscal.digitosNit)||'').replace(/\D/g,'');
    if(raw.length<2) return { pendiente:true };
    const dd = parseInt(raw.slice(-2),10);
    const idx = (dd===0) ? 49 : Math.floor((dd-1)/2);
    const iso = tabla[Math.min(idx, tabla.length-1)];
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const venc = new Date(iso+'T00:00:00');
    const dias = Math.round((venc - hoy)/86400000);
    return { iso, label: pfFechaLarga(iso), dias, dd: raw.slice(-2) };
  }
  function pfCalendarioResumen(){
    const f = state.fiscal;
    const debe = pfDebeDeclarar().debe;
    let h = '';
    // Renta
    const v = pfRentaVencimiento();
    if(!debe){
      h += '<div class="pf-cal-item"><div class="pf-cal-ico">✓</div><div><div class="pf-cal-t">Declaración de renta</div><div class="pf-cal-d">Con tus datos, este año <strong>no estás obligado</strong> a declarar. Si te retuvieron impuestos, declarar te puede devolver dinero.</div></div></div>';
    } else if(v && v.pendiente){
      h += '<div class="pf-cal-item"><div class="pf-cal-ico">📅</div><div><div class="pf-cal-t">Declaración de renta</div><div class="pf-cal-d">Para ver tu fecha exacta, completa los <strong>dos últimos dígitos de tu cédula</strong> en tu Perfil fiscal. En general, la declaración va entre el 12 de agosto y el 26 de octubre de 2026.</div></div></div>';
    } else if(v){
      const urg = v.dias<0 ? 'venc' : (v.dias<=30 ? 'alta' : 'ok');
      const cuando = v.dias<0 ? ('Venció hace '+Math.abs(v.dias)+' días') : (v.dias===0 ? '¡Es hoy!' : ('Faltan '+v.dias+' días'));
      h += '<div class="pf-cal-item pf-cal-'+urg+'"><div class="pf-cal-ico">📅</div><div><div class="pf-cal-t">Declaración de renta · <strong>'+v.label+'</strong></div><div class="pf-cal-d">'+cuando+'. Es tu fecha máxima para presentar (dígitos '+v.dd+'). Puedes hacerlo antes.</div></div></div>';
    }
    // IVA
    if(f.resp && f.resp.iva){
      const bimestral = pfIngresoAnualBruto() >= enPesos(92000);
      h += '<div class="pf-cal-item"><div class="pf-cal-ico">🧾</div><div><div class="pf-cal-t">IVA</div><div class="pf-cal-d">Declaras IVA de forma <strong>'+(bimestral?'bimestral (cada 2 meses)':'cuatrimestral (cada 4 meses)')+'</strong>, según el último dígito de tu cédula. Confirma el día exacto en la DIAN.</div></div></div>';
    }
    // Exógena
    const exo = pfExogenaObligado();
    const exVentana = ((fiscalConfig().calendario||{}).exogenaVentana) || ((fiscalConfig().exogena||{}).ventana) || 'mayo–junio 2026';
    if(exo.obligado===true){
      let porque = exo.motivo==='retencion' ? 'porque practicas retención en la fuente' : (exo.motivo==='simple' ? 'por tus ingresos en el Régimen Simple' : 'según tu perfil');
      h += '<div class="pf-cal-item"><div class="pf-cal-ico">📄</div><div><div class="pf-cal-t">Información exógena <span class="info-tip" data-def="resp_exogena" tabindex="0">i</span></div><div class="pf-cal-d">Debes reportarla '+porque+'. Se presenta en <strong>'+exVentana+'</strong>, según los dos últimos dígitos del NIT. Confirma el día exacto en la DIAN.</div></div></div>';
    } else if(exo.obligado==='revisar'){
      h += '<div class="pf-cal-item"><div class="pf-cal-ico">📄</div><div><div class="pf-cal-t">Información exógena <span class="info-tip" data-def="resp_exogena" tabindex="0">i</span></div><div class="pf-cal-d">Tus ingresos superan las 11.800 UVT: <strong>podrías estar obligado</strong> si además tus rentas de capital o no laborales pasan de 2.400 UVT. Revísalo con tu contador. Se presenta en '+exVentana+'.</div></div></div>';
    }
    // Simple
    if(f.regimen==='simple'){
      h += '<div class="pf-cal-item"><div class="pf-cal-ico">🧾</div><div><div class="pf-cal-t">Régimen Simple</div><div class="pf-cal-d">Pagas <strong>anticipos cada 2 meses</strong> y presentas una <strong>declaración anual</strong>. Las fechas van por el último dígito; confírmalas en la DIAN.</div></div></div>';
    }
    return h;
  }
  function pfObligacionesHtml(){
    const f = state.fiscal;
    const OBLICONS = {
      renta:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
      iva:'<svg viewBox="0 0 24 24"><path d="M2 7h20M5 7v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7M9 11h6"/></svg>',
      ica:'<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/></svg>',
      ret:'<svg viewBox="0 0 24 24"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      exo:'<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 9h8M8 13h8M8 17h5"/></svg>',
      ext:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>'
    };
    const items = [];
    // 1. Renta
    const dd = pfDebeDeclarar();
    if(dd.debe){
      const v = pfRentaVencimiento();
      let st='soon', stL='Próxima', next='ago–oct 2026';
      if(v && v.pendiente){ next='Completa tus dígitos'; }
      else if(v && typeof v.dias==='number'){
        next = v.label;
        if(v.dias<0){ st='due'; stL='Vencida'; }
        else if(v.dias<=30){ st='soon'; stL='Faltan '+v.dias+'d'; }
        else { st='ok'; stL='Próxima'; }
      }
      items.push({ico:'renta', t:'Declaración de renta', m:'Anual · persona natural', st, stL, next});
    } else {
      items.push({ico:'renta', t:'Declaración de renta', m:'Con tus datos, no estás obligado este año', st:'na', stL:'No obligado', next:'—', dim:true});
    }
    // 2. IVA
    if(f.resp && f.resp.iva){
      const bimestral = pfIngresoAnualBruto() >= enPesos(92000);
      items.push({ico:'iva', t:'IVA', m:'Responsable · '+(bimestral?'bimestral (cada 2 meses)':'cuatrimestral (cada 4 meses)'), st:'soon', stL:'Periódica', next:'Según NIT'});
    }
    // 3. ICA
    if(f.resp && f.resp.ica){
      const muni = ((fiscalConfig().ica||{}).medellin||{}).nombre || 'tu municipio';
      items.push({ico:'ica', t:'ICA · '+muni, m:'Industria y comercio · anual', st:'ok', stL:'Anual', next:'Según municipio'});
    }
    // 4. Retención en la fuente
    if(f.resp && f.resp.retencion){
      items.push({ico:'ret', t:'Retención en la fuente', m:'Agente retenedor · mensual', st:'soon', stL:'Mensual', next:'Según NIT'});
    }
    // 5. Información exógena
    const exo = pfExogenaObligado();
    const exVentana = ((fiscalConfig().calendario||{}).exogenaVentana) || 'mayo–junio 2026';
    if(exo.obligado===true){
      items.push({ico:'exo', t:'Información exógena', m:'Reporte de operaciones con terceros · anual', st:'soon', stL:'Obligado', next:exVentana, tip:'resp_exogena'});
    } else if(exo.obligado==='revisar'){
      items.push({ico:'exo', t:'Información exógena', m:'Podrías estar obligado según tus rentas de capital', st:'na', stL:'Revisar', next:exVentana, tip:'resp_exogena'});
    } else {
      items.push({ico:'exo', t:'Información exógena', m:'No aplica con tu perfil actual', st:'na', stL:'No aplica', next:'—', tip:'resp_exogena', dim:true});
    }
    // 6. Activos en el exterior
    const tieneExt = f.exterior && f.exterior.tiene && (f.exterior.valor||0) > enPesos(2000);
    if(tieneExt){
      items.push({ico:'ext', t:'Activos en el exterior', m:'Patrimonio fuera del país sobre 2.000 UVT · anual', st:'soon', stL:'Obligado', next:'Según NIT'});
    } else {
      items.push({ico:'ext', t:'Activos en el exterior', m:'Solo si tu patrimonio fuera del país supera 2.000 UVT', st:'na', stL:'No aplica', next:'—', dim:true});
    }
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">Tus obligaciones de este año</div>';
    html += '<p class="pf-note" style="margin-top:0">Según tu régimen y tus responsabilidades, esto es lo que te toca presentar ante la DIAN y el municipio.</p>';
    items.forEach(it=>{
      const tip = it.tip ? ' <span class="info-tip" data-def="'+it.tip+'" tabindex="0">i</span>' : '';
      html += '<div class="pf-obl-item'+(it.dim?' dim':'')+'">'
        + '<div class="pf-obl-ico">'+(OBLICONS[it.ico]||'')+'</div>'
        + '<div class="pf-obl-body"><div class="pf-obl-t">'+it.t+tip+'</div><div class="pf-obl-m">'+it.m+'</div></div>'
        + '<div class="pf-obl-r"><span class="pf-ost '+it.st+'">'+it.stL+'</span><div class="pf-obl-next">'+it.next+'</div></div>'
        + '</div>';
    });
    html += '<p class="pf-note">El día exacto de renta depende de los dos últimos dígitos de tu cédula; los de IVA y exógena, del NIT. Complétalos en tu Perfil fiscal para ver las fechas precisas.</p>';
    return html + '</div>';
  }

  function pfCalendarioHtml(){
    const f = state.fiscal;
    let html = '<div class="pf-diag-card"><div class="pf-diag-t">Tu calendario tributario 2026</div>';
    html += '<p class="pf-note" style="margin-top:0">Tus fechas límite ante la DIAN este año, según los datos de tu perfil.</p>';
    html += '<div id="pf-cal-out">'+pfCalendarioResumen()+'</div>';
    html += '<p class="pf-note">Las fechas de renta son las oficiales del calendario DIAN 2026. Si el último día cae en festivo o fin de semana, ya está contemplado. Presentar tarde genera sanción (desde ~$524.000).</p>';
    html += '</div>';
    return html;
  }

  function renderDiagnostico(){
    const cont = document.getElementById('pf-diagnostico'); if(!cont) return;
    const dd = pfDebeDeclarar(), renta = pfRentaEstimada(), iva = pfIvaPeriodo(), ica = pfIcaEstimado();
    const opt = ' <span style="font-weight:400;color:var(--ink-3,#6f6e6a);font-size:11px">estimación</span>';
    let html = '<div class="pf-diag-head"><h3>Tu diagnóstico fiscal'+opt+'</h3><p>Calculado con lo que registraste aquí y en los demás módulos. Es una estimación de planeación, no la liquidación oficial.</p></div>';

    html += '<div class="pf-diag-card '+(dd.debe?'is-warn':'is-ok')+'">';
    html += '<div class="pf-diag-t">'+(dd.debe?'Debes declarar renta':'Por ahora no estarías obligado a declarar renta')+'</div>';
    html += '<div class="pf-diag-s">'+(dd.debe
      ? 'Basta con superar <strong>uno</strong> de estos criterios. Así estás en cada uno:'
      : 'La ley revisa estos seis criterios; con tus datos no superas ninguno. Conviene revisarlo cada año.')+'</div>';
    dd.criterios.forEach(c=>{
      const val = (c.tope===null) ? (c.supera?'Sí':'No') : fmt(c.v);
      const sub = (c.uvt===null) ? 'criterio independiente' : c.uvt.toLocaleString('es-CO')+' UVT · tope '+fmt(c.tope);
      html += '<div class="pf-thr'+(c.supera?' over':'')+'">'
        + '<div class="pf-thr-name">'+c.k+'<small>'+sub+'</small></div>'
        + '<div class="pf-thr-val">'+val+'</div>'
        + '<div class="pf-thr-flag '+(c.supera?'over':'ok')+'">'+(c.supera?'!':'✓')+'</div>'
        + '</div>';
    });
    html += '<div class="pf-thr-uvt">Topes calculados con la UVT del año · UVT '+fmt(uvtValor())+'. Los consumos, compras y consignaciones los registras en tu Perfil fiscal.</div>';
    html += '</div>';

    const det = pfIngresoDetalle();
    html += '<div class="pf-diag-card"><div class="pf-diag-t">Conciliación de ingresos'+opt+'</div>';
    html += '<div class="pf-diag-s">Así se compone tu ingreso anual. Si una línea <strong>ya proviene de un activo</strong> del Mapa Patrimonial, márcala para no contarla dos veces (la renta del activo se cuenta por separado, abajo).</div>';
    if(det.lineas.length){
      html += '<div class="pf-concil">';
      det.lineas.forEach(l=>{
        html += '<label class="pf-concil-row'+(l.excluido?' is-excl':'')+'">'
          + '<input type="checkbox" data-incl-key="'+encodeURIComponent(l.key)+'"'+(l.excluido?' checked':'')+'>'
          + '<span class="pf-concil-nom">'+(l.nombre||'Ingreso')+' <em>'+l.fuente+'</em>'+(l.real?' <span class="pf-badge-real">Real</span>':'')+'</span>'
          + '<span class="pf-concil-val">'+fmt(l.anual)+'</span></label>';
      });
      html += '</div><div class="pf-concil-hint">Marca = "ya viene de un activo" → no se cuenta aquí.</div>';
    } else {
      html += '<p class="pf-note">No hay ingresos manuales en los módulos 1, 5 ni variables.</p>';
    }
    if(det.fuenteReal){
      html += '<div class="pf-note" style="margin-top:8px;color:var(--pos,#0e7c4a)">Tu ingreso de renta se está tomando de las cifras <strong>reales de tu presupuesto</strong> ('+det.mesesReales+'/12 meses registrados'+(det.mesesReales<12?'; los meses que faltan se estiman con tu cifra mensual':'')+'), en vez de anualizar un promedio. Como el ingreso fijo es tu única fuente, no hay riesgo de duplicar. Si agregas ingreso variable, de activos o no periódico, este puente se desactiva solo.</div>';
    }
    html += '<div class="pf-diag-row" style="margin-top:12px"><span>Ingresos manuales (no excluidos)</span><b>'+fmt(det.laboral+det.variable+det.noPeriodico)+'</b></div>';
    html += '<div class="pf-diag-row"><span>Renta de activos (campo de ingreso del Mapa)</span><b>'+fmt(det.deActivos)+'</b></div>';
    html += '<div class="pf-diag-out"><span>Ingreso anual total</span><b>'+fmt(det.total)+'</b></div></div>';

    html += '<div class="pf-diag-card"><div class="pf-diag-t">Impuesto de renta'+opt+'</div>';
    if(renta.esSimple){
      const simpleR = pfSimpleEstimado(+state.fiscal.simpleGrupo||4);
      html += '<div class="pf-diag-row"><span>Ingresos brutos del año</span><b>'+fmt(renta.ingresos)+'</b></div>';
      if(simpleR){
        html += '<div class="pf-diag-row"><span>Tarifa SIMPLE <span class="pf-mut">('+simpleR.grupo.nombre+')</span></span><b>'+(simpleR.tarifa*100).toFixed(1)+'%</b></div>';
        if(simpleR.incConsumo>0) html += '<div class="pf-diag-row pf-diag-off"><span>+ Impoconsumo 8% <span class="pf-mut">(solo si vendes comidas y bebidas)</span></span><b>—</b></div>';
        html += '<div class="pf-diag-out"><span>Impuesto SIMPLE estimado</span><b>'+fmt(simpleR.impuesto)+'</b></div>';
      }
      html += '<p class="pf-note">En <strong>Régimen Simple</strong> tu renta se liquida con una <strong>tarifa plana sobre los ingresos brutos</strong> que integra renta e ICA; no aplican deducciones ni el 25% exento. '+(simpleR&&simpleR.excedeTope?'<strong>⚠ Superas el tope de 100.000 UVT</strong>, revisa si aún puedes estar en el Simple. ':'')+'Puedes cambiar tu grupo de actividad en el comparador de abajo, que te muestra si te conviene frente al Ordinario.</p></div>';
    } else {
      const segLabel = renta.seg.origen==='registrado' ? 'registrado' : 'estimado';
      html += '<div class="pf-diag-row"><span>Ingresos de trabajo <span class="pf-mut">(salarios, honorarios)</span></span><b>'+fmt(renta.ingresoTrabajo)+'</b></div>';
      html += '<div class="pf-diag-row"><span>Ingresos no laborales <span class="pf-mut">(arriendos, rendimientos, otros)</span></span><b>'+fmt(renta.ingresoNoLaboral)+'</b></div>';
      html += '<div class="pf-diag-row pf-diag-strong"><span>Total ingresos del año</span><b>'+fmt(renta.ingresos)+'</b></div>';
      html += '<div class="pf-diag-row"><span>− Aportes obligatorios a salud y pensión <span class="pf-mut">('+segLabel+')</span></span><b>−'+fmt(renta.incrngo)+'</b></div>';
      html += '<div class="pf-diag-row"><span>Renta líquida</span><b>'+fmt(renta.rentaLiquida)+'</b></div>';
      // Deducciones y rentas exentas — cada una como línea de la cascada (las que están en "—" indican dónde registrarlas)
      html += '<div class="pf-diag-sub">Deducciones y rentas exentas <span class="pf-mut">(máx 40% / 1.340 UVT)</span></div>';
      // Razones dinámicas para dependientes (le dan retroalimentación al usuario cuando cambia el número en Metas)
      const r387 = renta.dep>0 ? (!renta.hayTrabajo ? 'tienes '+renta.dep+' a cargo, pero requiere rentas de trabajo' : (!renta.esLaboral ? 'tienes '+renta.dep+' a cargo; el 10% solo aplica con relación laboral (empleado/mixto)' : '')) : 'sin personas a cargo · regístralas en Metas y proyección';
      const r336 = renta.dep>0 ? (!renta.hayTrabajo ? 'tienes '+renta.dep+' a cargo, pero requiere rentas de trabajo' : '') : 'sin personas a cargo · regístralas en Metas y proyección';
      const lim = [
        ['25% exento de trabajo', renta.exenta25, 'sobre tus rentas de trabajo'],
        ['Aportes voluntarios FPV / AFC', renta.aporteVolReg, 'Perfil fiscal → "Para cerrar tu renta"'],
        ['Medicina prepagada', renta.dedSalud, 'de tus gastos de salud'],
        ['Dependientes · 10% (art. 387)', renta.dep387, r387],
        ['Intereses de vivienda'+(renta.viviendaEsAuto?' (de tus deudas)':''), renta.dedVivienda, 'de tu crédito hipotecario'],
        ['4x1000 (GMF) · 50%', renta.dedGMF, 'Perfil fiscal → "Para cerrar tu renta"']
      ];
      lim.forEach(d=>{
        if(d[1]>0) html += '<div class="pf-diag-row pf-diag-in"><span>− '+d[0]+'</span><b>−'+fmt(d[1])+'</b></div>';
        else html += '<div class="pf-diag-row pf-diag-in pf-diag-off"><span>− '+d[0]+' <span class="pf-mut">· '+d[2]+'</span></span><b>—</b></div>';
      });
      const sumInside = renta.exenta25 + renta.aporteVolReg + renta.dedSalud + renta.dep387 + renta.dedVivienda + renta.dedGMF;
      const exceso = sumInside - renta.beneficios;
      if(exceso > 0) html += '<div class="pf-diag-row pf-diag-in"><span>+ Excedente no deducible <span class="pf-mut">(supera el tope 40% / 1.340 UVT)</span></span><b>+'+fmt(exceso)+'</b></div>';
      html += '<div class="pf-diag-sub">Deducción adicional <span class="pf-mut">(no cuenta dentro del tope del 40% / 1.340 UVT)</span></div>';
      if(renta.dep336>0) html += '<div class="pf-diag-row pf-diag-in"><span>− Dependientes · 72 UVT c/u (art. 336) <span class="pf-mut">('+renta.dep+' a cargo)</span></span><b>−'+fmt(renta.dep336)+'</b></div>';
      else html += '<div class="pf-diag-row pf-diag-in pf-diag-off"><span>− Dependientes · 72 UVT (art. 336) <span class="pf-mut">· '+r336+'</span></span><b>—</b></div>';
      html += '<div class="pf-diag-row pf-diag-strong"><span>Renta líquida gravable</span><b>'+fmt(renta.baseGravable)+'</b></div>';
      html += '<div class="pf-diag-row"><span>Impuesto de renta</span><b>'+fmt(renta.impuesto)+'</b></div>';
      if(renta.retencion>0) html += '<div class="pf-diag-row"><span>− Retención ya practicada'+(renta.retencionEsAuto?' <span class="pf-mut">(de tus ingresos variables)</span>':'')+'</span><b>−'+fmt(renta.retencion)+'</b></div>';
      html += '<div class="pf-diag-out"><span>'+(renta.saldo>=0?'Saldo estimado a pagar':'Saldo a favor')+'</span><b>'+fmt(Math.abs(renta.saldo))+'</b></div>';
      html += '<p class="pf-note">'
        + (renta.seg.origen==='estimado' ? 'Seguridad social <strong>estimada</strong> ('+(renta.seg.tipo||'independiente')+'); regístrala en el Perfil fiscal para que sea exacta. ' : '')
        + 'Las líneas en "—" te dicen dónde registrar el dato para activar esa deducción. El 25% exento y los dependientes solo aplican a rentas de trabajo.</p></div>';
    }

    if(iva){
      html += '<div class="pf-diag-card"><div class="pf-diag-t">IVA del periodo</div>';
      html += '<div class="pf-diag-row"><span>IVA generado (ventas × '+Math.round(iva.tarifa*100)+'%)</span><b>'+fmt(iva.generado)+'</b></div>';
      html += '<div class="pf-diag-row"><span>− IVA descontable (compras)</span><b>'+fmt(iva.descontable)+'</b></div>';
      html += '<div class="pf-diag-out"><span>'+(iva.saldo>=0?'IVA a pagar':'Saldo a favor')+'</span><b>'+fmt(Math.abs(iva.saldo))+'</b></div></div>';
    }

    if(ica){
      html += '<div class="pf-diag-card"><div class="pf-diag-t">ICA estimado</div>';
      if(ica.integradoSimple) html += '<p class="pf-note">Estás en Régimen Simple: el ICA va integrado en la tarifa SIMPLE, no se declara aparte.</p>';
      else if(ica.sinTarifa) html += '<p class="pf-note">No hay tarifa de ICA configurada para tu municipio. Agrégala en la configuración fiscal para estimarlo.</p>';
      else html += '<div class="pf-diag-row"><span>Ingresos × '+ica.porMil+' por mil ('+ica.municipio+')</span><b>'+fmt(ica.valor)+'</b></div><p class="pf-note">La tarifa real depende de tu actividad y municipio.</p>';
      html += '</div>';
    }

    html += pfObligacionesHtml();
    html += pfCalendarioHtml();
    html += pfComparadorHtml();
    html += pfOptimizadorHtml();
    html += pfSasHtml();
    html += pfHerenciaHtml();
    html += pfPatrimonioHtml();

    cont.innerHTML = html;
    cont.querySelectorAll('[data-incl-key]').forEach(cb=>{
      cb.addEventListener('change', function(){
        const key = decodeURIComponent(this.getAttribute('data-incl-key'));
        if(!state.fiscal.ingresosExcluidos) state.fiscal.ingresosExcluidos = {};
        if(this.checked) state.fiscal.ingresosExcluidos[key] = true;
        else delete state.fiscal.ingresosExcluidos[key];
        scheduleSave('fiscal');
        renderCentroFiscal();
      });
    });
    const gsel = document.getElementById('pf-simple-grupo');
    if(gsel) gsel.addEventListener('change', function(){ state.fiscal.simpleGrupo = +this.value; scheduleSave('fiscal'); renderCentroFiscal(); });
    const slider = document.getElementById('pf-opt-slider');
    if(slider){
      slider.addEventListener('input', function(){
        const val = +this.value;
        const impSin = pfRentaEstimada({aporteVolOverride:0}).impuesto;
        const impCon = pfRentaEstimada({aporteVolOverride:val}).impuesto;
        const vEl=document.getElementById('pf-opt-val'), iEl=document.getElementById('pf-opt-imp'), aEl=document.getElementById('pf-opt-ahorro');
        if(vEl) vEl.textContent = fmt(val);
        if(iEl) iEl.textContent = fmt(impCon);
        if(aEl) aEl.textContent = fmt(impSin-impCon);
      });
      slider.addEventListener('change', function(){ state.fiscal.aporteVoluntario = +this.value; scheduleSave('fiscal'); renderCentroFiscal(); });
    }
    // Simulador SAS
    if(!state.fiscal.sas) state.fiscal.sas = { costosNegocio:0, salario:0, costosAnuales:null, repartoPct:100 };
    function pfSasRefresh(){
      const rep = document.getElementById('pf-sas-repval');
      if(rep) rep.textContent = (((state.fiscal.sas&&state.fiscal.sas.repartoPct)!=null)?state.fiscal.sas.repartoPct:100)+'%';
      const dyn = document.getElementById('pf-sas-dyn');
      if(dyn) dyn.innerHTML = pfSasCompHtml();
    }
    const sasCostos=document.getElementById('pf-sas-costos');
    if(sasCostos){
      sasCostos.value = (+state.fiscal.sas.costosNegocio>0) ? fmtInput(state.fiscal.sas.costosNegocio) : '';
      attachMoneyInput(sasCostos);
      sasCostos.addEventListener('input', function(){ state.fiscal.sas.costosNegocio = n(this.value); pfSasRefresh(); });
      sasCostos.addEventListener('blur', function(){ scheduleSave('fiscal'); });
    }
    const sasSalario=document.getElementById('pf-sas-salario');
    if(sasSalario){
      sasSalario.value = (+state.fiscal.sas.salario>0) ? fmtInput(state.fiscal.sas.salario) : '';
      attachMoneyInput(sasSalario);
      sasSalario.addEventListener('input', function(){ state.fiscal.sas.salario = n(this.value); pfSasRefresh(); });
      sasSalario.addEventListener('blur', function(){ scheduleSave('fiscal'); });
    }
    const sasSlider=document.getElementById('pf-sas-reparto');
    if(sasSlider){
      sasSlider.addEventListener('input', function(){ state.fiscal.sas.repartoPct=+this.value; const e=document.getElementById('pf-sas-repval'); if(e) e.textContent=this.value+'%'; pfSasRefresh(); });
      sasSlider.addEventListener('change', function(){ state.fiscal.sas.repartoPct=+this.value; scheduleSave('fiscal'); });
    }
    const sasMant=document.getElementById('pf-sas-mant');
    if(sasMant){
      const cfgSas=(fiscalConfig().sas)||{};
      const cur = state.fiscal.sas.costosAnuales!=null ? state.fiscal.sas.costosAnuales : (cfgSas.costoAnualTipico||6000000);
      sasMant.value = fmtInput(cur);
      attachMoneyInput(sasMant);
      sasMant.addEventListener('input', function(){ state.fiscal.sas.costosAnuales = n(this.value); pfSasRefresh(); });
      sasMant.addEventListener('blur', function(){ scheduleSave('fiscal'); });
    }
    // === Herencia: cableado ===
    (function(){
      if(!state.fiscal.herencia) state.fiscal.herencia = { vivienda:0, otrosInmuebles:0, otrosBienes:0, seguroVida:0, numHerederos:1, esLegitimario:true };
      const H = state.fiscal.herencia;
      const refrescarHer = ()=>{ const out=document.getElementById('pf-her-out'); if(out) out.innerHTML = pfHerenciaResumen(); };
      const money = (id, key)=>{
        const el = document.getElementById(id); if(!el) return;
        el.value = (+H[key]>0) ? fmtInput(H[key]) : '';
        attachMoneyInput(el);
        el.addEventListener('input', function(){ H[key] = n(this.value); refrescarHer(); });
        el.addEventListener('blur', function(){ scheduleSave('fiscal'); });
      };
      money('pf-her-viv','vivienda'); money('pf-her-oinm','otrosInmuebles'); money('pf-her-obien','otrosBienes'); money('pf-her-seg','seguroVida');
      const numEl = document.getElementById('pf-her-num');
      if(numEl){
        numEl.value = (+H.numHerederos>1) ? H.numHerederos : '';
        numEl.addEventListener('input', function(){ this.value=this.value.replace(/\D/g,'').slice(0,2); H.numHerederos = Math.max(1, +this.value||1); refrescarHer(); });
        numEl.addEventListener('blur', function(){ scheduleSave('fiscal'); });
      }
      const legEl = document.getElementById('pf-her-leg');
      if(legEl){ legEl.addEventListener('change', function(){ H.esLegitimario = (this.value==='si'); refrescarHer(); scheduleSave('fiscal'); }); }
    })();
    // === Impuesto al patrimonio: cableado ===
    (function(){
      if(!state.fiscal.patrimonio) state.fiscal.patrimonio = { viviendaHabitacion:0 };
      const P = state.fiscal.patrimonio;
      const el = document.getElementById('pf-pat-viv'); if(!el) return;
      el.value = (+P.viviendaHabitacion>0) ? fmtInput(P.viviendaHabitacion) : '';
      attachMoneyInput(el);
      el.addEventListener('input', function(){ P.viviendaHabitacion = n(this.value); const o=document.getElementById('pf-pat-out'); if(o) o.innerHTML = pfPatrimonioResumen(); });
      el.addEventListener('blur', function(){ scheduleSave('fiscal'); });
    })();
    // === Presupuesto: ahora vive en su propio módulo (12) ===
    cont.querySelectorAll('[data-cta-asesor]').forEach(b=> b.addEventListener('click', ()=>{ try{ navigateTo(9); }catch(e){} }));
    cont.querySelectorAll('[data-cta-whatsapp]').forEach(b=> b.addEventListener('click', ()=> abrirWhatsAppAsesor(b.textContent)));
  }

  /* ═══ FASE 3 · DETECTOR DE VULNERABILIDADES Y OPORTUNIDADES ═══ */
  function pfTarifaMarginal(){
    const renta = pfRentaEstimada();
    const bgUVT = (renta.baseGravable||0) / uvtValor();
    const tabla = (fiscalConfig().renta||{}).tabla241 || [];
    const r = tabla.find(x => bgUVT > x.desde && (x.hasta==null || bgUVT <= x.hasta));
    return r ? r.tarifa : 0;
  }

  function renderVulnerabilidades(){
    const cont = document.getElementById('pf-vulnerabilidades'); if(!cont) return;
    const f = state.fiscal;
    const ingreso = pfIngresoAnualBruto();
    const patrimonio = pfPatrimonioBruto();
    const marg = pfTarifaMarginal();
    const dd = pfDebeDeclarar();

    const vulns = [];
    if(dd.debe) vulns.push({sev:'alta', t:'Estás obligado a declarar renta', d:'Cumples '+dd.razones.length+' de los criterios para declarar. Hacerlo tarde genera sanción mínima e intereses.'});
    if(f.exterior && f.exterior.tiene && (f.exterior.valor||0) > enPesos(2000)) vulns.push({sev:'alta', t:'Activos en el exterior sin declarar', d:'Tus '+fmt(f.exterior.valor)+' superan las 2.000 UVT ('+fmt(enPesos(2000))+'): debes presentar la declaración anual de activos en el exterior, aparte de la renta.'});
    if((f.consignaciones||0) > ingreso*1.5 && ingreso>0) vulns.push({sev:'media', t:'Consignaciones muy por encima de tus ingresos', d:'Registras '+fmt(f.consignaciones)+' en consignaciones frente a '+fmt(ingreso)+' de ingresos. La DIAN cruza esa diferencia; conviene poder justificar el origen.'});
    if(f.resp && f.resp.iva && (f.iva.ventasGravadas||0)===0) vulns.push({sev:'media', t:'Eres responsable de IVA pero faltan tus ventas', d:'Sin las ventas gravadas no podemos estimar tu IVA a pagar ni avisarte de saldos. Complétalo en el Perfil fiscal.'});
    if(patrimonio>0 && ingreso>0 && patrimonio > ingreso*12) vulns.push({sev:'info', t:'Patrimonio alto frente a tus ingresos', d:'Tu patrimonio ('+fmt(patrimonio)+') es muy superior a tu ingreso anual. Si creció sin ingresos que lo respalden, la DIAN puede tratarlo como renta por comparación patrimonial. Vale la pena documentar el origen.'});
    const rDev = pfRentaEstimada();
    if(!rDev.esSimple && rDev.saldo < 0){
      const favor = Math.abs(rDev.saldo);
      vulns.push({sev:'ok', t:'Tienes un saldo a favor estimado de '+fmt(favor), d:'Tu retención del año supera el impuesto, así que la DIAN te debería devolver esa diferencia. Puedes pedir <strong>devolución</strong> (a tu cuenta) o <strong>compensación</strong> (contra otros impuestos) dentro de los 2 años siguientes al vencimiento, con el RUT actualizado, una certificación bancaria y la relación de retenciones (formato 1220). Si tu declaración es sencilla (sin dividendos ni ganancias ocasionales, sin deudas con la DIAN y presentada a tiempo), podrías recibir la devolución de oficio automáticamente.'});
    }

    const opps = [];
    const esSimple = f.regimen === 'simple';
    if(!esSimple && marg>0){
      const renta = pfRentaEstimada();
      // Aporte voluntario: cupo restante = tope − lo que ya aporta
      const cupoAporteTope = Math.min(0.30*ingreso, enPesos(3800));
      const cupoAporte = Math.max(0, cupoAporteTope - (renta.aporteVolReg||0));
      if(cupoAporte>0){
        const yaApta = (renta.aporteVolReg||0)>0 ? ' Ya aportas '+fmt(renta.aporteVolReg)+'; te queda este cupo.' : '';
        opps.push({t:'Aporte a pensión voluntaria / AFC', d:'Puedes aportar hasta '+fmt(cupoAporte)+' más (dentro del 30% de tu ingreso) y baja tu base de renta.'+yaApta, save:Math.round(cupoAporte*marg), cta:'Quiero aprovechar mi cupo', wa:true});
      }
      const dep = (state.profile && +state.profile.dependientes) || 0;
      if(dep>0 && (renta.dep387||0)===0 && (renta.dep336||0)===0){ opps.push({t:'Deducción por dependientes', d:'Tienes '+dep+' a cargo, pero hoy no se aplica (requiere rentas de trabajo). Si registras ingresos laborales, podrías deducir 72 UVT por dependiente y el 10% adicional.', save:0}); }
      // Medicina prepagada: cupo restante = tope − lo ya detectado/deducido
      const dedSaludTope = enPesos(16*12);
      const cupoSalud = Math.max(0, dedSaludTope - (renta.dedSalud||0));
      if(cupoSalud > 0){
        const yaSalud = (renta.dedSalud||0)>0 ? ' Ya deduces '+fmt(renta.dedSalud)+'; aún tienes este cupo.' : ' Si no tienes póliza, te conseguimos cotización: cobertura y menos impuesto.';
        opps.push({t:'Medicina prepagada / póliza de salud', d:'Deducible hasta 16 UVT/mes ('+fmt(dedSaludTope)+'/año) para ti y tu familia.'+yaSalud, save:Math.round(cupoSalud*marg), cta:'Solicitar cotización', wa:true});
      }
      if((renta.dedVivienda||0)===0) opps.push({t:'Intereses de crédito de vivienda', d:'Si tienes crédito hipotecario, los intereses son deducibles hasta 1.200 UVT/año ('+fmt(enPesos(1200))+'). Sube el certificado del banco.', save:Math.round(enPesos(1200)*marg)});
    }

    let html = '';
    html += '<div class="pf-diag-head"><h3>Vulnerabilidades y oportunidades</h3><p>Riesgos a cubrir y ahorros a tu alcance, detectados con tus datos. Cada uno lo puedes llevar a tu asesor.</p></div>';

    if(vulns.length){
      vulns.forEach(v=>{
        html += '<div class="pf-vuln sev-'+v.sev+'"><div class="pf-vuln-ico">'+(v.sev==='alta'?'!':(v.sev==='media'?'!':(v.sev==='ok'?'✓':'i')))+'</div>'
          + '<div class="pf-vuln-body"><div class="pf-vuln-t">'+v.t+'</div><div class="pf-vuln-d">'+v.d+'</div></div></div>';
      });
    } else {
      html += '<div class="pf-vuln sev-ok"><div class="pf-vuln-ico">✓</div><div class="pf-vuln-body"><div class="pf-vuln-t">Sin alertas de riesgo con tus datos actuales</div><div class="pf-vuln-d">Igual conviene revisarlo cada año y al cambiar de patrimonio o ingresos.</div></div></div>';
    }

    if(esSimple){
      html += '<div class="pf-note" style="margin-top:14px">Estás en Régimen Simple: las deducciones de renta (aportes, dependientes, salud, vivienda) no aplican, porque el Simple grava el ingreso bruto. Por eso no mostramos oportunidades de deducción.</div>';
    } else if(marg<=0){
      html += '<div class="pf-note" style="margin-top:14px">Con tu nivel de ingresos, tu renta aún no genera impuesto, así que las deducciones no producen ahorro hoy. Las recalculamos cuando suba tu ingreso.</div>';
    } else if(opps.length){
      html += '<div class="pf-opp-grid">';
      opps.forEach(o=>{
        html += '<div class="pf-opp"><div class="pf-opp-top"><div class="pf-opp-t">'+o.t+'</div><div class="pf-opp-save">'+fmt(o.save)+'<small>ahorro/año</small></div></div>'
          + '<div class="pf-opp-d">'+o.d+'</div>'
          + (o.cta?'<button class="pf-cta-mini" '+(o.wa?'data-cta-whatsapp':'data-cta-asesor')+'>'+o.cta+'</button>':'')
          + '</div>';
      });
      html += '</div>';
    }

    html += '<div class="pf-cta-row"><button class="pf-cta primary" data-cta-asesor>Agendar con mi asesor</button><button class="pf-cta" data-cta-asesor>Generar resumen para mi contador</button></div>';
    html += '<p class="pf-note" style="margin-top:14px">Los ahorros son estimaciones con tu tarifa marginal de renta; el beneficio real depende de tus soportes y de los límites combinados (40% / 1.340 UVT). Tu asesor lo valida y lo ejecuta antes del cierre del año.</p>';

    cont.innerHTML = html;
    cont.querySelectorAll('[data-cta-asesor]').forEach(b=>{
      b.addEventListener('click', ()=>{ try{ navigateTo(9); }catch(e){} });
    });
    cont.querySelectorAll('[data-cta-whatsapp]').forEach(b=>{
      b.addEventListener('click', ()=> abrirWhatsAppAsesor(b.textContent));
    });
  }

  function renderCentroFiscal(){
    renderDiagnostico();
    renderVulnerabilidades();
  }

  let _pfWired = false;
  function renderPerfilFiscal(){
    const f = state.fiscal;
    document.querySelectorAll('#pf-regimen button').forEach(b=> b.classList.toggle('active', (b.dataset.r||'')===(f.regimen||'')));
    document.querySelectorAll('.pf-tgl[data-k]').forEach(t=>{ const k=t.dataset.k; t.classList.toggle('on', !!(f.resp && f.resp[k])); });
    const setVal=(id,v)=>{ const el=document.getElementById(id); if(el) el.value = (v||v===0)?v:''; };
    setVal('pf-ciiu', f.ciiu); setVal('pf-municipios', f.municipios);
    setVal('pf-digCedula', f.digitosCedula); setVal('pf-digNit', f.digitosNit);
    const setMoney=(id,v)=>{ const el=document.getElementById(id); if(el) el.value = v>0?fmtInput(v):''; };
    setMoney('pf-consumos', f.consumosTarjeta); setMoney('pf-compras', f.comprasConsumos); setMoney('pf-consignaciones', f.consignaciones);
    // Sugerencia editable y visible para "compras y consumos totales": estimado desde los gastos registrados.
    (function(){
      const el = document.getElementById('pf-compras'); const hint = document.getElementById('pf-compras-hint');
      if(!el || !hint) return;
      const est = pfGastoAnualEstimado();
      if(est>0){
        hint.style.display = 'block';
        hint.innerHTML = 'Según tus gastos registrados, tus compras del año rondan <strong>'+fmt(est)+'</strong>. <span id="pf-compras-usar" style="color:var(--accent);cursor:pointer;text-decoration:underline">Usar este valor</span> y ajústalo con tu extracto.';
        const usar = document.getElementById('pf-compras-usar');
        if(usar) usar.addEventListener('click', function(){ f.comprasConsumos = est; el.value = fmtInput(est); scheduleSave('fiscal'); });
      } else {
        hint.style.display = 'none';
      }
    })();
    setMoney('pf-ivaVentas', f.iva.ventasGravadas); setMoney('pf-ivaCompras', f.iva.comprasConIva);
    setMoney('pf-segSalud', f.segSocial.salud); setMoney('pf-segPension', f.segSocial.pension);
    setMoney('pf-intVivienda', f.interesesVivienda); setMoney('pf-retencion', f.retencion);
    setMoney('pf-aporteVol', f.aporteVoluntario); setMoney('pf-gmf', f.gmf);
    const viviendaAuto = pfInteresesViviendaAuto();
    const intViv = document.getElementById('pf-intVivienda');
    if(intViv && viviendaAuto>0 && !(f.interesesVivienda>0)) intViv.placeholder = fmt(viviendaAuto)+' (auto)';
    const retDet = pfIngresoDetalle().retencionDetectada || 0;
    const retEst = pfRetencionTrabajoEstimada();
    const retEl = document.getElementById('pf-retencion');
    if(retEl && !(f.retencion>0)){
      if(retDet>0) retEl.placeholder = fmt(retDet)+' (de variables)';
      else if(retEst>0) retEl.placeholder = '≈ '+fmt(retEst)+' (estimada)';
    }
    const fpvHint = document.getElementById('pf-fpvHint');
    if(fpvHint){
      const prep = pfPrepagadaAnual();
      let msg = '';
      if(viviendaAuto>0) msg += 'Detectamos un <strong>crédito hipotecario</strong>: estimamos '+fmt(viviendaAuto)+' de intereses al año (saldo × tasa). ';
      if(pfTieneFPV()) msg += 'Detectamos un <strong>FPV/AFC</strong> en tu patrimonio (registramos el saldo, no el aporte del año: escríbelo arriba). ';
      if(prep>0) msg += 'Detectamos <strong>'+fmt(prep)+'/año</strong> en salud como medicina prepagada; verifica que no incluya tu EPS obligatoria. ';
      if(retDet>0) msg += 'Tomamos <strong>'+fmt(retDet)+'</strong> de retención del año <strong>de tus ingresos variables</strong> (bruto × % de retención de cada contrato); ajústala con tus certificados si difiere.';
      else if(retEst>0) msg += 'Tu retefuente del año sobre rentas de trabajo se estima en <strong>'+fmt(retEst)+'</strong> (tabla art. 383); reemplázala con el valor exacto de tus certificados para el saldo real.';
      fpvHint.innerHTML = msg;
      fpvHint.style.display = msg ? 'block' : 'none';
    }
    const tglExt=document.getElementById('pf-tglExt'); if(tglExt) tglExt.classList.toggle('on', !!f.exterior.tiene);
    const extWrap=document.getElementById('pf-extWrap'); if(extWrap) extWrap.style.display = f.exterior.tiene?'grid':'none';
    setMoney('pf-extValor', f.exterior.valor); setMoney('pf-extIngresos', f.exterior.ingresos);
    pfActualizarExtNota();
    renderPfActivos();
    if(!_pfWired){ wirePerfilFiscal(); _pfWired = true; }
    renderCentroFiscal();
  }

  function wirePerfilFiscal(){
    const f = state.fiscal;
    const redib = ()=>{ try{ renderCentroFiscal(); }catch(e){} };
    document.querySelectorAll('#pf-regimen button').forEach(b=>{
      b.addEventListener('click',()=>{ f.regimen=b.dataset.r||''; document.querySelectorAll('#pf-regimen button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); scheduleSave('fiscal'); redib(); });
    });
    document.querySelectorAll('.pf-tgl[data-k]').forEach(t=>{
      t.addEventListener('click',e=>{ if(e.target.closest('.info-tip'))return; const k=t.dataset.k; f.resp[k]=!f.resp[k]; t.classList.toggle('on', f.resp[k]); scheduleSave('fiscal'); redib(); });
    });
    const txt=(id,prop)=>{ const el=document.getElementById(id); if(el) el.addEventListener('input',function(){ f[prop]=this.value; scheduleSave('fiscal'); }); };
    txt('pf-ciiu','ciiu'); txt('pf-municipios','municipios'); txt('pf-digCedula','digitosCedula'); txt('pf-digNit','digitosNit');
    const money=(id,setter)=>{ const el=document.getElementById(id); if(el){ attachMoneyInput(el); el.addEventListener('input',function(){ setter(n(this.value)); scheduleSave('fiscal'); redib(); }); } };
    money('pf-consumos', v=>f.consumosTarjeta=v);
    money('pf-compras', v=>f.comprasConsumos=v);
    money('pf-consignaciones', v=>f.consignaciones=v);
    money('pf-ivaVentas', v=>f.iva.ventasGravadas=v);
    money('pf-ivaCompras', v=>f.iva.comprasConIva=v);
    money('pf-segSalud', v=>{ f.segSocial.salud=v; redib(); });
    money('pf-segPension', v=>{ f.segSocial.pension=v; redib(); });
    money('pf-intVivienda', v=>{ f.interesesVivienda=v; redib(); });
    money('pf-retencion', v=>{ f.retencion=v; redib(); });
    money('pf-aporteVol', v=>{ f.aporteVoluntario=v; redib(); });
    money('pf-gmf', v=>{ f.gmf=v; redib(); });
    if(!f.simpleCheck) f.simpleCheck = {};
    [['pf-sc-residente','residente'],['pf-sc-actividad','actividad'],['pf-sc-realidad','realidad'],['pf-sc-aldia','aldia'],['pf-sc-factura','factura'],['pf-sc-socio','socio']].forEach(function(par){
      const el = document.getElementById(par[0]);
      if(el){
        el.value = f.simpleCheck[par[1]] || '';
        el.addEventListener('change', function(){ f.simpleCheck[par[1]] = this.value; scheduleSave('fiscal'); });
      }
    });
    const tglExt=document.getElementById('pf-tglExt');
    if(tglExt) tglExt.addEventListener('click',e=>{ if(e.target.closest('.info-tip'))return; f.exterior.tiene=!f.exterior.tiene; tglExt.classList.toggle('on', f.exterior.tiene); document.getElementById('pf-extWrap').style.display=f.exterior.tiene?'grid':'none'; pfActualizarExtNota(); scheduleSave('fiscal'); redib(); });
    money('pf-extValor', v=>{ f.exterior.valor=v; pfActualizarExtNota(); redib(); });
    money('pf-extIngresos', v=>f.exterior.ingresos=v);
    const goCentro = document.querySelector('[data-goto="11"]');
    if(goCentro) goCentro.addEventListener('click', ()=>{ try{ navigateTo(11); }catch(e){} });
  }


  /* ═══════════════════════════════════════════════════════════════════════════
     MÓDULO 13 · ESTRUCTURA LEGAL PATRIMONIAL
     Motor de reglas, formulario, diagnóstico y definiciones.
     ═══════════════════════════════════════════════════════════════════════════ */

  const LEGAL_UMBRALES = {
    exteriorUVT: 2000,                    // Formulario 160 (art. 607 ET)
    herVivUVT: 13000,                     // Art. 307 num. 1 ET
    herOtrosInmUVT: 6500,                 // Art. 307 num. 2 ET
    herLegitimarioUVT: 3250,              // Art. 307 num. 3 ET
    seguroVidaExentoUVT: 3250,            // Art. 303-1 ET
    negocioValorSMMLV: 200,
    negocioIngresoAnualUVT: 500,
    ingresoPasivoRelevanteUVT: 40,        // mensuales (se anualiza en R2)
    concentracionDirectaPct: 0.85,
    concentracionVehiculoPct: 0.60,
    copropiedadValorSMMLV: 100,
    testamentoAntiguedadAnios: 5,
    patrimonioSinTestamentoSMMLV: 500,
    iliquidezCriticaPct: 0.60,
    umhPresuncionAnios: 2,                // Ley 54/1990 art. 2
    avalRelevantePctPatrimonio: 0.30,
  };

  const SMMLV_2026 = 1750905;   // Decreto 1469 del 29 de diciembre de 2025
  const getSMMLV = () => (typeof window !== 'undefined' && window.SMMLV_ACTUAL) || SMMLV_2026;

  // CIIUs de actividades con exposición profesional alta
  const CIIU_RIESGO_PROFESIONAL = [
    { prefijo:'71', desc:'arquitectura, ingeniería y consultoría técnica' },
    { prefijo:'69', desc:'jurídicas y contables' },
    { prefijo:'70', desc:'consultoría de gestión' },
    { prefijo:'86', desc:'salud humana' },
    { prefijo:'87', desc:'atención en instituciones' },
    { prefijo:'85', desc:'educación' },
    { prefijo:'88', desc:'servicios sociales sin alojamiento' },
    { prefijo:'41', desc:'construcción de edificios' },
    { prefijo:'42', desc:'obras de ingeniería civil' },
    { prefijo:'43', desc:'actividades especializadas de construcción' }
  ];

  // ════════════════════════════════════════════════════════════════════════
  // EVALUACIÓN PATRIMONIAL EN 4 CAPAS · Motor (Fase 1)
  // Protección · Liquidez · Crecimiento · Sucesoral
  // Las capas se calculan en orden: LIQUIDEZ alimenta a SUCESORAL.
  // Todo umbral es configurable y validable. Nada se asume: lo que no está
  // capturado se reporta en `datosFaltantes`, no se inventa.
  // ════════════════════════════════════════════════════════════════════════
  const CAPAS_UMBRALES = {
    proteccion: {
      exposicionDirectaBien: 0.40, exposicionDirectaRiesgo: 0.75,
      coberturaRCMinPctPatrimonio: 0.25,      // suma asegurada mínima vs patrimonio expuesto
      avalRelevantePct: 0.30,
      umhPresuncionAnios: 2,                  // Ley 54/1990 art. 2
    },
    liquidez: {
      runwayBienMeses: 6, runwayRiesgoMeses: 3,
      runwayIngresoVariableExtra: 3,          // ingreso volátil exige más colchón
      ratioLiquidoMinimo: 0.10,
      concentracionIliquidaPct: 0.60,
    },
    crecimiento: {
      productivoBien: 0.50, productivoRiesgo: 0.25,
      inflacionAnual: 0.05,
    },
    diversificacion: {
      claseMayorConcentrada: 0.70,
      activoMayorConcentrado: 0.40,
      monedaUnicaConcentrada: 0.90,
      sectorMayorConcentrado: 0.50,
      apuestasEfectivasMin: 3,                // 1/HHI mínimo deseable
    },
    sucesoral: {
      coberturaBien: 1.0, coberturaRiesgo: 0.5,
      mesesProcesoSucesion: 18,               // duración típica del trámite
      costoProcesoPct: 0.02,                  // notarial/judicial sobre el acervo
      accesoBancarioSinSucesionUVT: 1750,     // liberación parcial sin sucesión
      testamentoAntiguedadAnios: 5,
    },
    pesos: { proteccion:35, liquidez:25, diversificacion:20, crecimiento:20 },
  };

  const capaEstado = (score) => score >= 70 ? 'bien' : (score >= 40 ? 'atencion' : 'riesgo');
  // Índice Herfindahl: 1 = todo concentrado en uno. 1/HHI = "apuestas efectivas".
  function capasHHI(pesos){
    const tot = pesos.reduce((s,v)=>s+v,0);
    if(tot <= 0) return { hhi:0, efectivas:0 };
    const hhi = pesos.reduce((s,v)=>s+Math.pow(v/tot,2),0);
    return { hhi, efectivas: hhi>0 ? 1/hhi : 0 };
  }
  function capasAgrupar(items, keyFn){
    const m = {};
    items.forEach(a => { const k = keyFn(a) || '(sin dato)'; m[k] = (m[k]||0) + (a.valor||0); });
    return m;
  }
  // Un fondo/ETF amplio NO es una apuesta única: por dentro ya está diversificado.
  function capasEsDiversificado(a){
    if(a._reparto === 'muchas') return true;    // lo dijo el usuario: manda sobre cualquier suposición
    if(a._reparto === 'una') return false;
    const s = ((a._subtipo||'') + ' ' + (a.nombre||'')).toLowerCase();
    return /etf|fondo|fic|indice|índice|colectiv|portafolio|diversific/.test(s);
  }

  function capasDatosMapa(){
    try{
      if(window.MapaPatrimonial && window.MapaPatrimonial.getData){
        const d = window.MapaPatrimonial.getData();
        return { acts: d.activosNormalizados||[], resumen: d.resumen||{}, raw: d.activos||[] };
      }
    }catch(e){}
    return { acts:[], resumen:{}, raw:[] };
  }

  // ── CAPA 1 · PROTECCIÓN ────────────────────────────────────────────────
  function capaProteccion(ctx){
    const { acts, bruto, neto } = ctx;
    const L = (state.fiscal && state.fiscal.legal) || {};
    const brechas = [], faltantes = [];
    const directos = acts.filter(a => !a._estructuraLegal || a._estructuraLegal === 'Propiedad Directa');
    const valDirecto = directos.reduce((s,a)=>s+(a.valor||0),0);
    const expo = bruto > 0 ? valDirecto/bruto : 0;
    const U = CAPAS_UMBRALES.proteccion;
    let score = 100;
    if(expo > U.exposicionDirectaRiesgo){ score -= 45; const t = expo >= 0.995 ? 'Todo tu patrimonio está a tu nombre' : 'Casi todo tu patrimonio está a tu nombre';
      brechas.push({sev:'alta', titulo:t, detalle:'El '+Math.round(expo*100)+'% ('+fmt(valDirecto)+') está a tu nombre, sin ninguna sociedad o fiducia de por medio. Si te demandan, si te embargan o si hay un divorcio, se puede ir todo junto.'}); }
    else if(expo > U.exposicionDirectaBien){ score -= 20; brechas.push({sev:'media', titulo:'Buena parte del patrimonio sin vehículo de protección', detalle:'El '+Math.round(expo*100)+'% está a tu nombre directamente.'}); }
    // Cobertura de responsabilidad: se mide contra la exposición, no como sí/no.
    const rc = (L.coberturas && L.coberturas.rcProfesional) || {};
    const ciiu = ciiuTieneRiesgoProfesional(state.fiscal && state.fiscal.ciiu);
    if(ciiu){
      if(rc.tiene === false || rc.tiene == null){ score -= 20; brechas.push({sev:'alta', titulo:'Actividad de riesgo sin póliza de responsabilidad civil', detalle:'Tu actividad ('+ciiu.desc+') expone tu patrimonio personal a reclamaciones. No hay RC registrada.'}); }
      else if((rc.sumaAsegurada||0) > 0 && (rc.sumaAsegurada||0) < valDirecto*U.coberturaRCMinPctPatrimonio){ score -= 10; brechas.push({sev:'media', titulo:'La póliza de RC puede quedarse corta', detalle:'Cubre '+fmt(rc.sumaAsegurada)+' frente a '+fmt(valDirecto)+' expuestos.'}); }
    }
    // El ingreso es el motor del patrimonio: si se detiene, todo lo demás se erosiona.
    const inv = (L.coberturas && L.coberturas.invalidez) || {};
    if(inv.tiene === false){ score -= 12; brechas.push({sev:'alta', titulo:'Si no pudieras trabajar, no hay nada que reemplace tu ingreso', detalle:'No tienes un seguro que te siga pagando si una enfermedad o un accidente te dejan sin poder trabajar. Los gastos seguirían y tocaría vivir del patrimonio.'}); }
    // Un aval personal borra la separación que da la sociedad.
    if(L.avalSociedad === true){ score -= 18; brechas.push({sev:'alta', titulo:'Firmaste personalmente las deudas de tu empresa', detalle:'Tener la empresa en una sociedad separa tu patrimonio del de ella, pero al firmar como codeudor esa separación no aplica a esa deuda: tus bienes personales responden igual.'}); }
    if(L.viviendaProtegida === false){ score -= 6; brechas.push({sev:'media', titulo:'Tu vivienda no tiene protección frente a embargos', detalle:'Existe una figura que se inscribe en la notaría y hace que tu casa no responda por deudas. Sin ella, tu vivienda queda expuesta como cualquier otro bien.'}); }
    const dyo = (L.coberturas && L.coberturas.dyo) || {};
    if(dyo.tiene === false) { score -= 8; brechas.push({sev:'media', titulo:'Administrador sin póliza D&O', detalle:'Como administrador respondes con tu patrimonio por decisiones de la sociedad.'}); }
    // Avales y pleitos: comprometen patrimonio aunque no sean deuda propia.
    const aval = L.avalesTerceros || {};
    if(aval.tiene && (aval.monto||0) > 0 && neto > 0 && (aval.monto/neto) > U.avalRelevantePct){
      score -= 15; brechas.push({sev:'alta', titulo:'Avales que comprometen tu patrimonio', detalle:'Respondes por '+fmt(aval.monto)+', el '+Math.round(aval.monto/neto*100)+'% de tu patrimonio neto.'});
    }
    const pl = L.pleitosVigentes || {};
    if(pl.tieneComoDemandado && (pl.montoPretensiones||0) > 0){ score -= 12; brechas.push({sev:'alta', titulo:'Pleito vigente en tu contra', detalle:'Pretensiones por '+fmt(pl.montoPretensiones)+'.'}); }
    // Régimen conyugal (incluye unión marital de hecho: sociedad patrimonial por presunción).
    const anios = L.anioMatrimonioUnion ? (new Date().getFullYear() - (+L.anioMatrimonioUnion||0)) : null;
    if(L.estadoCivil === 'union_libre' && anios != null && anios >= U.umhPresuncionAnios && !L.regimenConyugal){
      score -= 8; brechas.push({sev:'media', titulo:'Unión marital sin claridad de régimen', detalle:'Tras '+anios+' años se presume sociedad patrimonial: la mitad de lo construido podría ser del compañero(a).'});
    }
    const restringidos = acts.filter(a=>a.restringido).reduce((s,a)=>s+(a.valor||0),0);
    if(restringidos > 0) brechas.push({sev:'baja', titulo:'Activos con restricción legal', detalle:fmt(restringidos)+' están pignorados, embargados o con limitación: no son respaldo disponible.'});
    // Lo que la app aún no captura (para no dar falsa tranquilidad).
    // La sucesión es parte de proteger: protege el patrimonio del evento más seguro de todos.
    const suc = subSucesion(ctx);
    score -= Math.round(suc.penal * 0.5);              // pesa la mitad dentro de la capa
    suc.brechas.forEach(b=>brechas.push(b));
    suc.datosFaltantes.forEach(f=>faltantes.push(f));
    score = Math.max(0, Math.min(100, score));
    return { id:'proteccion', nombre:'Protección', estado:capaEstado(score), score,
      metricas:{ exposicionDirectaPct:expo, valorExpuesto:valDirecto, valorRestringido:restringidos, sucesion:suc.metricas },
      brechas, datosFaltantes:faltantes };
  }

  // ── CAPA 2 · LIQUIDEZ ──────────────────────────────────────────────────
  function capaLiquidez(ctx){
    const { acts, bruto } = ctx;
    const U = CAPAS_UMBRALES.liquidez;
    const brechas = [], faltantes = [];
    const liquidosLibres = acts.filter(a => a.tipo === 'LÍQUIDO' && !a.restringido).reduce((s,a)=>s+(a.valor||0),0);
    const totalLiquidos = acts.filter(a => a.tipo === 'LÍQUIDO').reduce((s,a)=>s+(a.valor||0),0);
    // Fondo voluntario: el dinero sale en días, salvo dos casos que sí lo bloquean o lo demoran.
    const fpvBloqueado = acts.filter(a => a._subtipo === 'Fondo de pensiones voluntarias FPV' && a._fpvInstitucional).reduce((s,a)=>s+(a.valor||0),0);
    const fpvConPermanencia = acts.filter(a => a._subtipo === 'Fondo de pensiones voluntarias FPV' && !a._fpvInstitucional && a._fpvPermanencia).reduce((s,a)=>s+(a.valor||0),0);
    // Seguro de pensión con ahorro: si ya cumplió el plazo, recuperas el valor completo → cuenta como disponible.
    const segPensionListo = acts.filter(a => a._subtipo === 'Seguro de pensión con ahorro' && a._vigenciaCumplida && !a.restringido).reduce((s,a)=>s+(a.valor||0),0);
    const segPensionConCosto = acts.filter(a => a._subtipo === 'Seguro de pensión con ahorro' && !a._vigenciaCumplida && !a.restringido).reduce((s,a)=>s+(a.valor||0),0);
    const fondo = (state.p5 && state.p5.fondoProvisiones) || 0;
    const gastoMes = gastoMensualTotal();
    // Colchón por tramos de horizonte: la emergencia se cubre con lo que llega ya o en días.
    const noRestr = acts.filter(a => !a.restringido);
    const inmediato = noRestr.filter(a => a._horizonte === 'inmediato').reduce((s,a)=>s+(a.valor||0),0) + fondo;
    const enDias = noRestr.filter(a => a._horizonte === 'dias' && a._subtipo !== 'Fondo de pensiones voluntarias FPV').reduce((s,a)=>s+(a.valor||0),0);
    const fpvDisponible = Math.max(0, acts.filter(a => a._subtipo === 'Fondo de pensiones voluntarias FPV' && !a.restringido).reduce((s,a)=>s+(a.valor||0),0) - fpvBloqueado - fpvConPermanencia);
    // Colchón de emergencia = lo inmediato + lo de pocos días (incluye FPV disponible y seguro de pensión ya cumplido).
    const disponible = Math.max(0, inmediato + enDias + fpvDisponible + segPensionListo);
    const runway = gastoMes > 0 ? disponible/gastoMes : null;
    const runwayInmediato = gastoMes > 0 ? inmediato/gastoMes : null;
    // Cupos de crédito sin usar: respaldo real, pero con costo. No es ahorro, así que
    // NO entra al colchón; se muestra aparte como la salida de emergencia que es.
    const cupos = (+state.cuposDisponibles) || 0;
    const runwayConCupos = (gastoMes > 0 && cupos > 0) ? (disponible + cupos)/gastoMes : null;
    const totalLiquidosH = inmediato - fondo + enDias + fpvDisponible;   // sin el fondo de provisiones, para el ratio
    const ratio = bruto > 0 ? (inmediato - fondo + enDias + fpvDisponible + segPensionListo)/bruto : 0;
    // El colchón exigido sube si el ingreso es volátil.
    const hayVariable = !!(state.varIncome && (state.varIncome.activo || (state.varIncome.meses||[]).length));
    const objetivoMeses = U.runwayBienMeses + (hayVariable ? U.runwayIngresoVariableExtra : 0);
    let score = 100;
    if(runway == null){ score -= 20; brechas.push({sev:'media', titulo:'Falta saber cuánto gastas al mes', detalle:'Sin tu gasto mensual no puedo calcular cuántos meses aguantarías. Regístralo en Ingresos y Gastos.'}); }
    else if(runway < U.runwayRiesgoMeses){ score -= 45; brechas.push({sev:'alta', titulo:'Colchón por debajo de lo mínimo', detalle:'Cubres '+runway.toFixed(1)+' meses de gastos con dinero propio. Un imprevisto te obligaría a endeudarte o a vender con descuento.'+(cupos>0?' Con tus cupos de crédito llegarías a '+runwayConCupos.toFixed(1)+' meses, pero eso es deuda: sirve para salir del paso, no reemplaza el ahorro.':'')}); }
    else if(runway < objetivoMeses){ score -= 20; brechas.push({sev:'media', titulo:'Colchón por debajo de tu objetivo', detalle:'Cubres '+runway.toFixed(1)+' meses; para tu perfil'+(hayVariable?' (ingreso variable)':'')+' conviene '+objetivoMeses+'.'}); }
    if(ratio < U.ratioLiquidoMinimo && bruto > 0){ score -= 15; brechas.push({sev:'media', titulo:'Casi todo tu patrimonio está inmovilizado', detalle:'Solo el '+Math.round(ratio*100)+'% es líquido.'}); }
    if(segPensionConCosto > 0){ brechas.push({sev:'baja', titulo:'Tienes un ahorro de pensión que aún no cumple su plazo', detalle:'Ese dinero ('+fmt(segPensionConCosto)+') es tuyo y puedes sacarlo, pero al hacerlo antes de tiempo te descuentan gastos de cancelación y el ahorro de impuestos, así que recibirías menos. Por eso no lo cuento como parte de tu colchón disponible.'}); }
    if(fpvBloqueado > 0){ brechas.push({sev:'media', titulo:'Parte de tu fondo voluntario lo controla tu empresa', detalle:'Hay '+fmt(fpvBloqueado)+' en un fondo abierto por tu empleador. La parte que aporta la empresa suele tener condiciones para poder sacarla, así que no la cuento como dinero disponible para una emergencia. Confirma con tu área de gente o con la administradora cuánto podrías retirar hoy.'}); }
    if(fpvConPermanencia > 0){ brechas.push({sev:'baja', titulo:'Tu fondo voluntario tiene un plazo mínimo acordado', detalle:'Hay '+fmt(fpvConPermanencia)+' donde acordaste dejar el dinero un tiempo. Sigue siendo tuyo, pero sacarlo antes puede costarte una comisión o tomar más días, así que no lo cuento como disponible inmediato.'}); }
    const conPenalidad = noRestr.filter(a => a._horizonte === 'penalidad' && a._subtipo !== 'Seguro de pensión con ahorro').reduce((s,a)=>s+(a.valor||0),0);
    if(conPenalidad > 0){ brechas.push({sev:'baja', titulo:'Parte de tu dinero está en productos a plazo', detalle:'Tienes '+fmt(conPenalidad)+' en productos como CDT o cuenta AFC. Puedes acceder a ese dinero, pero sacarlo antes de tiempo suele costar intereses o penalidad, así que no lo cuento como colchón inmediato.'}); }
        const iliquidos = acts.filter(a => a.tipo !== 'LÍQUIDO');
    if(iliquidos.length && bruto > 0){
      const mayor = iliquidos.reduce((m,a)=> (a.valor||0)>(m.valor||0)?a:m, iliquidos[0]);
      if((mayor.valor||0)/bruto > U.concentracionIliquidaPct){ score -= 12; brechas.push({sev:'media', titulo:'Un solo bien ilíquido domina tu patrimonio', detalle:'"'+mayor.nombre+'" es el '+Math.round(mayor.valor/bruto*100)+'%. Venderlo toma meses y suele exigir descuento.'}); }
    }
    score = Math.max(0, Math.min(100, score));
    return { id:'liquidez', nombre:'Liquidez', estado:capaEstado(score), score,
      metricas:{ runwayMeses:runway, objetivoMeses, ratioLiquido:ratio, disponibleInmediato:disponible, soloInmediato:inmediato, enDias, runwayInmediato, conPenalidad, liquidosLibres, cupos, runwayConCupos, fpvBloqueado, fpvConPermanencia },
      brechas, datosFaltantes:faltantes };
  }

  // ── CAPA 3 · CRECIMIENTO (con diversificación en 7 dimensiones) ────────
  function capaCrecimiento(ctx){
    const { acts, bruto, resumen } = ctx;
    const U = CAPAS_UMBRALES.crecimiento;
    const brechas = [], faltantes = [];
    const productivos = acts.filter(a => a._esProductivo).reduce((s,a)=>s+(a.valor||0),0);
    const pctProd = bruto > 0 ? productivos/bruto : 0;
    // Distinto: los que HOY están dando renta registrada (no solo los que podrían).
    const conRenta = acts.filter(a => (a._ingresoMensual||0) > 0).reduce((s,a)=>s+(a.valor||0),0);
    const pctConRenta = bruto > 0 ? conRenta/bruto : 0;
    let score = 100;
    if(pctProd < U.productivoRiesgo){ score -= 35; brechas.push({sev:'alta', titulo:'Tu patrimonio casi no trabaja', detalle:'Solo el '+Math.round(pctProd*100)+'% genera renta o se aprecia; el resto son bienes de uso.'}); }
    else if(pctProd < U.productivoBien){ score -= 15; brechas.push({sev:'media', titulo:'Parte importante del patrimonio no produce', detalle:'El '+Math.round(pctProd*100)+'% es productivo.'}); }
    // ── Rendimiento TOTAL: lo que rinde = renta que te paga + cuánto se valoriza ──
    // Medir solo el valor final mezcla lo que ahorras con lo que producen los bienes.
    // Por eso separamos: rendimiento de los bienes, y aparte cuánto aportas tú ahorrando.
    const rentaAnual = acts.reduce((s,a)=>s+(a._ingresoMensual||0)*12,0);
    const rendRenta = bruto > 0 ? rentaAnual/bruto : 0;                 // flujo (arriendos, dividendos)
    // Valorización anualizada ponderada por valor (solo activos con precio de compra y fecha).
    let pesoVal = 0, sumaVal = 0;
    acts.forEach(a=>{ const v = a._valorizacionPct; if(v != null && isFinite(v) && (a.valor||0) > 0){ pesoVal += a.valor; sumaVal += v * a.valor; } });
    const rendValorizacion = pesoVal > 0 ? sumaVal/pesoVal : null;      // precio (se aprecia o se deprecia)
    const rendTotal = rendRenta + (rendValorizacion || 0);
    const rendReal = rendTotal - U.inflacionAnual;                      // descontando inflación
    const rendImplicito = rendTotal;
    // Cuánto crece tu patrimonio porque TÚ le metes plata (ahorro), no porque rinda.
    const ingMes = (typeof pgIngresoMensualGeneral === 'function') ? pgIngresoMensualGeneral() : 0;
    const gasMes = gastoMensualTotal();
    const cuotasMes = (typeof deudaServicioMensual === 'function') ? deudaServicioMensual() : 0;
    const ahorroMes = (ingMes > 0) ? Math.max(0, ingMes - gasMes - cuotasMes) : null;
    const tasaAhorro = (ingMes > 0) ? (ingMes - gasMes - cuotasMes)/ingMes : null;
    const aporteAnual = ahorroMes != null ? ahorroMes*12 : null;
    const crecPorAhorro = (aporteAnual != null && bruto > 0) ? aporteAnual/bruto : null;
    if(rendReal < 0){ score -= 20; brechas.push({sev:'alta', titulo:'Tu patrimonio no le gana a la inflación', detalle:'Sumando lo que te renta ('+(rendRenta*100).toFixed(1)+'%) y lo que se valoriza ('+(rendValorizacion==null?'sin datos de compra':(rendValorizacion*100).toFixed(1)+'%')+'), da '+(rendTotal*100).toFixed(1)+'% al año, por debajo de la inflación ('+(U.inflacionAnual*100).toFixed(1)+'%). En términos reales tu patrimonio se está reduciendo.'}); }
    else if(rendReal < 0.02){ score -= 10; brechas.push({sev:'media', titulo:'Tu patrimonio apenas le gana a la inflación', detalle:'Rinde '+(rendTotal*100).toFixed(1)+'% al año contra una inflación de '+(U.inflacionAnual*100).toFixed(1)+'%: ganas apenas '+(rendReal*100).toFixed(1)+'% de poder de compra.'}); }
    if(tasaAhorro != null && tasaAhorro <= 0){ score -= 15; brechas.push({sev:'alta', titulo:'No estás sumando ahorro nuevo', detalle:'Hoy gastas todo lo que te entra, así que tu patrimonio solo puede crecer por lo que rindan tus bienes. Ahorrar es la palanca más rápida cuando el patrimonio aún es pequeño.'}); }
    else if(tasaAhorro != null && tasaAhorro < 0.10){ score -= 8; brechas.push({sev:'media', titulo:'Ahorras muy poco de lo que ganas', detalle:'Estás guardando el '+Math.round(tasaAhorro*100)+'% de tus ingresos. Subirlo mueve tu patrimonio más rápido que buscar mejores rendimientos.'}); }
    if(rendValorizacion == null) brechas.push({sev:'baja', titulo:'Falta saber con cuánto entró cada bien a tu patrimonio', detalle:'Sin ese punto de partida no puedo medir cuánto se han valorizado. Si lo compraste, es el precio que pagaste. Si lo heredaste o te lo donaron, es el valor que tenía cuando lo recibiste (el del avalúo o la escritura). Complétalo en cada activo del Mapa Patrimonial.'});
    if(pctProd > 0.5 && pctConRenta < 0.2){ brechas.push({sev:'media', titulo:'Tienes bienes que podrían producir y no lo están haciendo', detalle:'El '+Math.round(pctProd*100)+'% de tu patrimonio es del tipo que puede generar renta, pero solo el '+Math.round(pctConRenta*100)+'% tiene una renta registrada en la app. Si alguno sí te renta (por ejemplo un arriendo que anotaste como ingreso no periódico), regístralo en el activo para que la medición sea exacta.'}); }
    score = Math.max(0, Math.min(100, score));
    return { id:'crecimiento', nombre:'Crecimiento', estado:capaEstado(score), score,
      metricas:{ pctProductivo:pctProd, pctConRenta, rendimientoImplicito:rendImplicito, rentaAnual, brutoRef:bruto, rendRenta, rendValorizacion, rendTotal, rendReal, tasaAhorro, aporteAnual, crecPorAhorro, ingMes, gasMes, cuotasMes, inflacion:U.inflacionAnual, proyeccion:(resumen&&resumen.patrimonioProyectado)||null },
      brechas, datosFaltantes:faltantes };
  }

  // ── CAPA 4 · DIVERSIFICACIÓN (7 dimensiones) ───────────────────────────
  // No es lo mismo tener mucho que tenerlo repartido: mide de cuántas cosas
  // distintas depende tu patrimonio, para que un solo golpe no se lo lleve todo.
  function capaDiversificacion(ctx){
    const { acts, bruto } = ctx;
    const U = CAPAS_UMBRALES.diversificacion;
    const brechas = [], faltantes = [];
    let score = 100;
    const div = {};
    // 1) Por clase de activo
    const porClase = capasAgrupar(acts, a=>a._categoria);
    const hClase = capasHHI(Object.values(porClase));
    const claseMayor = Object.entries(porClase).sort((a,b)=>b[1]-a[1])[0] || ['—',0];
    div.clase = { grupos:porClase, hhi:hClase.hhi, efectivas:hClase.efectivas, mayorNombre:claseMayor[0], mayorPct: bruto>0?claseMayor[1]/bruto:0 };
    if(div.clase.mayorPct > U.claseMayorConcentrada){ score -= 12; brechas.push({sev:'media', titulo:'Concentración por tipo de activo', detalle:'El '+Math.round(div.clase.mayorPct*100)+'% está en "'+claseMayor[0]+'".'}); }
    // 2) Por activo individual (look-through: un ETF amplio no es una sola apuesta)
    const apuestas = acts.map(a => ({ nombre:a.nombre, valor:a.valor||0, diversificado:capasEsDiversificado(a) }));
    const mayorAct = apuestas.filter(x=>!x.diversificado).sort((a,b)=>b.valor-a.valor)[0] || null;
    div.activo = { mayorNombre: mayorAct?mayorAct.nombre:'—', mayorPct: (mayorAct&&bruto>0)?mayorAct.valor/bruto:0,
      top3Pct: bruto>0 ? apuestas.slice().sort((a,b)=>b.valor-a.valor).slice(0,3).reduce((s,x)=>s+x.valor,0)/bruto : 0 };
    if(div.activo.mayorPct > U.activoMayorConcentrado){ score -= 12; brechas.push({sev:'alta', titulo:'Un solo bien pesa demasiado', detalle:'"'+div.activo.mayorNombre+'" es el '+Math.round(div.activo.mayorPct*100)+'% de tu patrimonio.'}); }
    // 3) Por moneda
    const porMoneda = capasAgrupar(acts, a=>a._moneda||'COP');
    const dura = Object.entries(porMoneda).filter(([m])=>m!=='COP').reduce((s,[,v])=>s+v,0);
    const hMon = capasHHI(Object.values(porMoneda));
    div.moneda = { grupos:porMoneda, pctMonedaDura: bruto>0?dura/bruto:0, efectivas:hMon.efectivas };
    if(bruto > 0 && div.moneda.pctMonedaDura === 0){ score -= 8; brechas.push({sev:'media', titulo:'Todo tu patrimonio está en pesos', detalle:'Sin activos en moneda dura, una devaluación reduce tu poder de compra global.'}); }
    // 4) Geográfica / jurisdiccional
    const porPais = capasAgrupar(acts, a=>a._pais||'Colombia');
    const fuera = Object.entries(porPais).filter(([p])=>!/colombia/i.test(p)).reduce((s,[,v])=>s+v,0);
    div.geografica = { grupos:porPais, jurisdicciones:Object.keys(porPais).length, pctExterior: bruto>0?fuera/bruto:0 };
    if(bruto > 0 && div.geografica.pctExterior === 0) brechas.push({sev:'baja', titulo:'Todo concentrado en una sola jurisdicción', detalle:'Todo está en Colombia: quedas expuesto al riesgo país.'});
    // 5) Por sector / emisor (dentro de lo financiero)
    const fin = acts.filter(a => a._categoria === 'Financiero');
    const finTot = fin.reduce((s,a)=>s+(a.valor||0),0);
    const porSector = capasAgrupar(fin, a=>a._sector);
    const hSec = capasHHI(Object.values(porSector));
    const secMayor = Object.entries(porSector).sort((a,b)=>b[1]-a[1])[0] || ['—',0];
    div.sector = { grupos:porSector, hhi:hSec.hhi, efectivas:hSec.efectivas, mayorNombre:secMayor[0], mayorPct: finTot>0?secMayor[1]/finTot:0 };
    if(finTot > 0 && div.sector.mayorPct > U.sectorMayorConcentrado && secMayor[0] !== '(sin dato)'){ score -= 8; brechas.push({sev:'media', titulo:'Tu portafolio financiero depende de un sector', detalle:'El '+Math.round(div.sector.mayorPct*100)+'% está en "'+secMayor[0]+'".'}); }
    // 6) Por horizonte (cruce con liquidez)
    div.horizonte = { pctLiquido: ctx.capaLiquidez ? ctx.capaLiquidez.metricas.ratioLiquido : null };
    // 7) Correlación ingreso ↔ patrimonio (el riesgo doble)
    const ciiu = ciiuTieneRiesgoProfesional(state.fiscal && state.fiscal.ciiu);
    const sectorIngreso = (ciiu && ciiu.desc) || '';
    const inmueblePct = bruto>0 ? (porClase['Inmueble']||0)/bruto : 0;
    const correl = (/construcci|inmobiliar/i.test(sectorIngreso) && inmueblePct > 0.5);
    div.correlacionIngreso = { sectorIngreso, correlacionado: correl };
    if(correl){ score -= 10; brechas.push({sev:'alta', titulo:'Tu ingreso y tu patrimonio dependen de lo mismo', detalle:'Trabajas en '+sectorIngreso+' y el '+Math.round(inmueblePct*100)+'% de tu patrimonio es inmobiliario: una crisis del sector te golpea por los dos lados.'}); }
    const apEf = capasHHI(acts.map(a=>a.valor||0)).efectivas;
    if(apEf > 0 && apEf < U.apuestasEfectivasMin){ score -= 10; brechas.push({sev:'media', titulo:'Tu patrimonio depende de muy pocas cosas', detalle:'Aunque tengas varios bienes, el peso está tan concentrado que es como si tuvieras solo '+apEf.toFixed(1)+'. Es decir: si a una sola cosa le va mal, se ve casi todo tu patrimonio. Lo sano es que el peso esté repartido en al menos '+U.apuestasEfectivasMin+'.'}); }
    div.apuestasEfectivas = apEf;
    score = Math.max(0, Math.min(100, score));
    return { id:'diversificacion', nombre:'Diversificación', estado:capaEstado(score), score,
      metricas:{ diversificacion:div }, brechas, datosFaltantes:faltantes };
  }

  // ── SUB-BLOQUE · SUCESIÓN (vive dentro de PROTECCIÓN; consume la capa de liquidez) ──
  // Proteger el patrimonio incluye protegerlo del evento más seguro de todos: la muerte.
  function subSucesion(ctx){
    const { acts, bruto, neto, capaLiquidez } = ctx;
    const U = CAPAS_UMBRALES.sucesoral;
    const L = (state.fiscal && state.fiscal.legal) || {};
    const brechas = [], faltantes = [];
    const dependientes = (+L.hijosMenores||0) + (+L.hijosMayoresDependientes||0) + (+L.otrosDependientes||0);
    // NECESIDAD de caja: impuesto + proceso + vida de los dependientes + deudas.
    // Con sociedad conyugal, la mitad de lo construido en el matrimonio ya es del cónyuge:
    // esa parte no se hereda, así que la base del impuesto es menor.
    const gananciales = (L.regimenConyugal === 'sociedad_conyugal') ? 0.5 : 1;
    const acervoHeredable = bruto * gananciales;
    const impuestoHerencia = pfImpuestoHerenciaEstimado(acervoHeredable);
    const costoProceso = Math.round(acervoHeredable * U.costoProcesoPct);
    const gastoFamilia = (+L.gastoMensualFamilia||0) || gastoMensualTotal();
    const vidaDependientes = dependientes > 0 ? gastoFamilia * U.mesesProcesoSucesion : 0;
    const deudas = Math.max(0, bruto - neto);
    const necesidad = impuestoHerencia + costoProceso + vidaDependientes + deudas;
    // DISPONIBLE: lo que llega rápido y NO se congela en la sucesión.
    const seguros = (L.segurosVida||[]).reduce((s,x)=>s+(+x.sumaAsegurada||0),0);
    const segurosDirectos = (L.segurosVida||[]).filter(x=>x.beneficiarios && x.beneficiarios !== 'legales').reduce((s,x)=>s+(+x.sumaAsegurada||0),0);
    const accesoBancario = Math.min(enPesos(U.accesoBancarioSinSucesionUVT), (capaLiquidez&&capaLiquidez.metricas.liquidosLibres)||0);
    const enVehiculo = acts.filter(a => /fideicomiso|holding/i.test(a._estructuraLegal||'')).reduce((s,a)=>s+(a.valor||0),0);
    // El seguro de pensión con ahorro (ej. Crea Patrimonio) entrega a los beneficiarios sin pasar por la sucesión.
    const seguroPension = acts.filter(a => a._subtipo === 'Seguro de pensión con ahorro').reduce((s,a)=>s+(a.valor||0),0);
    const fueraDeSucesion = enVehiculo + seguroPension;
    const disponible = segurosDirectos + accesoBancario + fueraDeSucesion;
    const cobertura = necesidad > 0 ? disponible/necesidad : (disponible>0?2:1);
    let score = 100;
    if(cobertura < U.coberturaRiesgo){ score -= 45; brechas.push({sev:'alta', titulo:'Tus herederos no tendrían con qué pagar', detalle:'Se necesitarían '+fmt(necesidad)+' (impuesto, proceso, deudas y sostenimiento) y solo hay '+fmt(disponible)+' de acceso rápido: faltan '+fmt(Math.max(0,necesidad-disponible))+'. Tendrían que vender bienes con descuento.'}); }
    else if(cobertura < U.coberturaBien){ score -= 20; brechas.push({sev:'media', titulo:'La caja para la sucesión queda justa', detalle:'Cubre el '+Math.round(cobertura*100)+'% de los '+fmt(necesidad)+' que se necesitarían.'}); }
    // Instrumentos
    const t = L.testamento || {};
    if(t.tiene === false || t.tiene == null){
      if(dependientes > 0 || bruto > getSMMLV()*LEGAL_UMBRALES.patrimonioSinTestamentoSMMLV){
        score -= 20; brechas.push({sev:'alta', titulo:'Sin testamento', detalle:(dependientes>0? dependientes+' persona(s) dependen de ti y ':'')+'tu patrimonio se repartiría según la ley, no según tu voluntad.'});
      }
    } else if(t.anioOtorgamiento && (new Date().getFullYear() - (+t.anioOtorgamiento||0)) > U.testamentoAntiguedadAnios && t.revisadoTrasCambios !== true){
      score -= 10; brechas.push({sev:'media', titulo:'Testamento desactualizado', detalle:'Tiene '+(new Date().getFullYear()-(+t.anioOtorgamiento))+' años y no se ha revisado tras los cambios de tu patrimonio.'});
    }
    if((+L.hijosMenores||0) > 0 && L.guardaDesignada === false){ score -= 12; brechas.push({sev:'alta', titulo:'No está definido quién cuidaría a tus hijos ni quién manejaría lo que hereden', detalle:'Si ustedes faltaran, lo decidiría un juez. Dejarlo por escrito evita demoras y asegura que sea quien ustedes querrían.'}); }
    const hayEmpresa = acts.some(a => a._categoria === 'Empresarial');
    if(hayEmpresa && L.protocoloFamiliar === false){ score -= 10; brechas.push({sev:'media', titulo:'Tu empresa no tiene reglas escritas para cuando falte un socio', detalle:'La parte de quien fallece pasa a sus herederos, que pueden no conocer el negocio ni querer seguir. Sin un acuerdo previo, la empresa se traba o se vende barata.'}); }
    if(dependientes > 0 && seguros <= 0){ score -= 20; brechas.push({sev:'alta', titulo:'Dependientes sin seguro de vida', detalle:dependientes+' persona(s) dependen de ti y no hay una suma que les dé liquidez inmediata.'}); }
    else if(seguros > 0 && segurosDirectos < seguros){ score -= 8; brechas.push({sev:'media', titulo:'Seguros sin beneficiario designado', detalle:fmt(seguros-segurosDirectos)+' quedarían atrapados en la herencia en vez de llegar directo.'}); }
    if(ctx.pctExterior > 0) brechas.push({sev:'media', titulo:'Activos en el exterior: sucesión transfronteriza', detalle:'Pueden requerir un trámite adicional en el otro país y generar impuesto sucesoral extranjero (por ejemplo, el estate tax de EE. UU. sobre activos allá).'});
    const penal = Math.max(0, 100 - Math.max(0, Math.min(100, score)));   // cuánto castiga a Protección
    return { penal, metricas:{ necesidadCaja:necesidad, disponibleRapido:disponible, cobertura, impuestoHerencia, costoProceso, vidaDependientes, dependientes,
        segurosDirectos, accesoBancario, fueraDeSucesion, deudas, gananciales, acervoHeredable },
      brechas, datosFaltantes:faltantes };
  }

  // Impuesto de la herencia (ganancia ocasional) con las exenciones del art. 307 ET.
  function pfImpuestoHerenciaEstimado(acervo){
    const cfg = fiscalConfig();
    const tarifa = (cfg.gananciaOcasional && cfg.gananciaOcasional.tarifa) || 0.15;
    const exento = enPesos(LEGAL_UMBRALES.herLegitimarioUVT);
    return Math.max(0, Math.round((Math.max(0, acervo - exento)) * tarifa));
  }

  // ── MOTOR ──────────────────────────────────────────────────────────────
  function evaluarPatrimonio(){
    const { acts, resumen } = capasDatosMapa();
    const bruto = resumen.patrimonioBrutoCOP || acts.reduce((s,a)=>s+(a.valor||0),0);
    const neto = resumen.patrimonioNetoCOP != null ? resumen.patrimonioNetoCOP : bruto;
    const pctExterior = bruto>0 ? acts.filter(a=>!/colombia/i.test(a._pais||'Colombia')).reduce((s,a)=>s+(a.valor||0),0)/bruto : 0;
    const ctx = { acts, resumen, bruto, neto, pctExterior };
    const liquidez = capaLiquidez(ctx);
    ctx.capaLiquidez = liquidez;                       // la sucesión (dentro de protección) y el horizonte la consumen
    const proteccion = capaProteccion(ctx);            // incluye la preparación de la sucesión
    const crecimiento = capaCrecimiento(ctx);
    const diversificacion = capaDiversificacion(ctx);
    const capas = { proteccion, liquidez, crecimiento, diversificacion };
    const P = CAPAS_UMBRALES.pesos;
    const pesoTot = P.proteccion+P.liquidez+P.crecimiento+P.diversificacion;
    const indice = Math.round((proteccion.score*P.proteccion + liquidez.score*P.liquidez + crecimiento.score*P.crecimiento + diversificacion.score*P.diversificacion)/pesoTot);
    const lista = [proteccion, liquidez, crecimiento, diversificacion];
    const eslabonDebil = lista.reduce((m,c)=> c.score < m.score ? c : m, lista[0]);
    // Riesgos que se COMPONEN entre capas (no se ven mirando una sola).
    const compounding = [];
    acts.forEach(a=>{
      const directo = !a._estructuraLegal || a._estructuraLegal==='Propiedad Directa';
      const iliquido = a.tipo !== 'LÍQUIDO';
      const exterior = !/colombia/i.test(a._pais||'Colombia');
      if(directo && iliquido && bruto>0 && (a.valor||0)/bruto > 0.3)
        compounding.push({ activo:a.nombre, detalle:'Pesa el '+Math.round(a.valor/bruto*100)+'%, está a tu nombre y es difícil de vender: golpea protección, liquidez y sucesión a la vez.' });
      if(exterior && directo)
        compounding.push({ activo:a.nombre, detalle:'Está en el exterior y a tu nombre: suma riesgo de cumplimiento y una posible sucesión en otra jurisdicción.' });
    });
    return { capas, orden:['proteccion','liquidez','crecimiento','diversificacion'], indice, eslabonDebil:eslabonDebil.id, compounding,
      contexto:{ patrimonioBruto:bruto, patrimonioNeto:neto, cantidadActivos:acts.length } };
  }

  try{ window.evaluarPatrimonio = evaluarPatrimonio; window.CAPAS_UMBRALES = CAPAS_UMBRALES; }catch(e){}

  // ── FASE 2 · Tablero visual de las 4 capas ─────────────────────────────
  var capasAbiertas = {};   // UI transitoria: qué capas están expandidas
  const CAPA_ICONO = {
    proteccion:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z"/></svg>',
    liquidez:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3s6 6.4 6 10a6 6 0 0 1-12 0c0-3.6 6-10 6-10z"/></svg>',
    crecimiento:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>',
    diversificacion:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><line x1="8.5" y1="6" x2="15.5" y2="6"/><line x1="6" y1="8.5" x2="6" y2="15.5"/><line x1="18" y1="8.5" x2="18" y2="15.5"/><line x1="8.5" y1="18" x2="15.5" y2="18"/></svg>'
  };
  const CAPA_LEMA = {
    proteccion:'Si te demandan o si faltas, ¿qué pasa con tus bienes?',
    liquidez:'Si necesitas plata ya, ¿de dónde la sacas?',
    diversificacion:'¿De cuántas cosas distintas depende tu patrimonio?',
    crecimiento:'¿Tus bienes producen o solo están ahí?'
  };
  const capasPct = (x)=> Math.round((x||0)*100)+'%';
  // Monto con el prefijo separado del número: así "COP $" queda alineado entre filas.
  function capasMonto(v){
    const t = fmt(v||0); const i = t.lastIndexOf(' ');
    const pre = i>0 ? t.slice(0,i) : ''; const num = i>0 ? t.slice(i+1) : t;
    return '<span class="capa-cur">'+pre+'</span><span class="capa-num">'+num+'</span>';
  }

  function capaMetricaClave(c){
    const m = c.metricas || {};
    if(c.id==='proteccion') return { valor: capasPct(m.exposicionDirectaPct), etq:'de tu patrimonio está a tu nombre' };
    if(c.id==='liquidez')  return { valor: (m.runwayMeses==null?'—':m.runwayMeses.toFixed(1)+' meses'), etq:'de gastos cubiertos (objetivo '+m.objetivoMeses+')' };
    if(c.id==='crecimiento') return { valor: capasPct(m.pctProductivo), etq:'de tus bienes son de los que pueden producir (no son de uso personal)' };
    const d = m.diversificacion||{};
    return { valor: (d.apuestasEfectivas||0).toFixed(1), etq:'cosas distintas entre las que se reparte de verdad tu patrimonio' };
  }

  function capasDivHtml(div){
    if(!div) return '';
    const fila = (etq, val, nota) => '<div class="capa-div-row"><span class="capa-div-l">'+etq+'</span><span class="capa-div-v">'+val+'</span>'+(nota?'<span class="capa-div-n">'+nota+'</span>':'')+'</div>';
    let h = '<div class="capa-div"><div class="capa-div-t">Diversificación en detalle</div>';
    h += fila('Por clase de activo', capasPct(div.clase.mayorPct)+' en '+escapeHtml(div.clase.mayorNombre), (div.clase.efectivas||0).toFixed(1)+' clases efectivas');
    h += fila('Por bien individual', capasPct(div.activo.mayorPct)+(div.activo.mayorNombre!=='—'?' en '+escapeHtml(div.activo.mayorNombre):''), 'top 3: '+capasPct(div.activo.top3Pct));
    h += fila('Por moneda', capasPct(div.moneda.pctMonedaDura)+' en moneda dura', (div.moneda.efectivas||0).toFixed(1)+' monedas efectivas');
    h += fila('Por jurisdicción', capasPct(div.geografica.pctExterior)+' en el exterior', div.geografica.jurisdicciones+' país(es)');
    if(Object.keys(div.sector.grupos||{}).length) h += fila('Por sector financiero', capasPct(div.sector.mayorPct)+' en '+escapeHtml(div.sector.mayorNombre), (div.sector.efectivas||0).toFixed(1)+' sectores efectivos');
    h += fila('En cuántas cosas se reparte de verdad', (div.apuestasEfectivas||0).toFixed(1), 'si un bien pesa mucho más que el resto, cuenta casi como si fuera el único');
    if(div.correlacionIngreso && div.correlacionIngreso.correlacionado) h += fila('Ingreso vs patrimonio', 'Correlacionados', 'tu trabajo y tus bienes dependen del mismo sector');
    h += '</div>';
    return h;
  }

  function capaCardHtml(c){
    const mk = capaMetricaClave(c);
    const abierta = !!capasAbiertas[c.id];
    const top = (c.brechas||[]).slice(0, abierta ? 99 : 2);
    let h = '<div class="capa-card '+c.estado+(abierta?' open':'')+'">';
    h += '<button class="capa-head" data-capa="'+c.id+'">'
       + '<span class="capa-ic">'+(CAPA_ICONO[c.id]||'')+'</span>'
       + '<span class="capa-hd"><span class="capa-n">'+c.nombre+'</span><span class="capa-lema">'+CAPA_LEMA[c.id]+'</span></span>'
       + '<span class="capa-badge">'+(c.estado==='bien'?'Bien':(c.estado==='atencion'?'Atención':'Riesgo'))+'</span>'
       + '<span class="capa-ch">'+(abierta?'▴':'▾')+'</span></button>';
    h += '<div class="capa-metrica"><span class="v">'+mk.valor+'</span><span class="l">'+mk.etq+'</span></div>';
    h += '<div class="capa-bar" title="Puntaje de esta capa"><span style="width:'+c.score+'%"></span></div>';
    h += '<div class="capa-score-l">Puntaje de esta capa: <strong>'+c.score+'</strong>/100 · baja con cada problema detectado</div>';
    if(top.length){
      h += '<ul class="capa-brechas">';
      top.forEach(b=>{ h += '<li class="sev-'+b.sev+'"><strong>'+b.titulo+'</strong>'+(abierta?'<span>'+b.detalle+'</span>':'')+'</li>'; });
      h += '</ul>';
      const ocultas = Math.max(0, (c.brechas||[]).length - 2);
      if(!abierta) h += '<button class="capa-mas" data-capa="'+c.id+'">'+(ocultas>0 ? '+'+ocultas+' más · ver el detalle' : 'Ver el detalle')+'</button>';
    } else {
      h += '<div class="capa-ok">Sin problemas detectados en esta capa.</div>';
      if(!abierta) h += '<button class="capa-mas" data-capa="'+c.id+'">Ver el detalle</button>';
    }
    if(abierta){
      if(c.id==='liquidez'){
        const m=c.metricas;
        h += '<div class="capa-div"><div class="capa-div-t">Con qué cuentas si algo pasa mañana</div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Hoy mismo <span class="capa-div-n2">cuentas, efectivo, fiducia y tu fondo de provisiones</span></span><span class="capa-div-v">'+capasMonto(m.soloInmediato)+'</span></div>'
          + ((m.enDias||0)>0 ? '<div class="capa-div-row"><span class="capa-div-l">En pocos días <span class="capa-div-n2">acciones, ETF, fondos: se venden en 2-3 días hábiles</span></span><span class="capa-div-v">'+capasMonto(m.enDias)+'</span></div>' : '')
          + '<div class="capa-div-row tot"><span class="capa-div-l">Colchón real de emergencia</span><span class="capa-div-v">'+capasMonto(m.disponibleInmediato)+'</span></div>'
          + ((m.conPenalidad||0)>0 ? '<div class="capa-div-row"><span class="capa-div-l">Aparte: a plazo con penalidad <span class="capa-div-n2">CDT, AFC: sacarlo antes cuesta</span></span><span class="capa-div-v">'+capasMonto(m.conPenalidad)+'</span></div>' : '')
          + '<div class="capa-div-row"><span class="capa-div-l">Te alcanza para <span class="capa-div-n2">objetivo para tu perfil: '+m.objetivoMeses+' meses</span></span><span class="capa-div-v">'+(m.runwayMeses==null?'sin datos':m.runwayMeses.toFixed(1)+' meses')+'</span></div>'
          + ((m.cupos||0)>0 ? '<div class="capa-div-row"><span class="capa-div-l">Respaldo con tus cupos de crédito <span class="capa-div-n2">es deuda, no ahorro: llegarías a '+(m.runwayConCupos?m.runwayConCupos.toFixed(1):'—')+' meses, pero pagando intereses</span></span><span class="capa-div-v">'+capasMonto(m.cupos)+'</span></div>' : '')
          + ((m.fpvBloqueado||0)>0 ? '<div class="capa-div-row"><span class="capa-div-l">No lo cuento: fondo de tu empresa <span class="capa-div-n2">tiene condiciones para retirarlo</span></span><span class="capa-div-v">'+capasMonto(m.fpvBloqueado)+'</span></div>' : '')
          + ((m.fpvConPermanencia||0)>0 ? '<div class="capa-div-row"><span class="capa-div-l">No lo cuento: fondo con plazo acordado <span class="capa-div-n2">sacarlo antes cuesta o demora</span></span><span class="capa-div-v">'+capasMonto(m.fpvConPermanencia)+'</span></div>' : '')
          + '</div>';
      }
      if(c.id==='diversificacion') h += capasDivHtml(c.metricas.diversificacion);
      if(c.id==='crecimiento'){
        const m=c.metricas; const pp=(x)=> x==null?'sin datos':((x*100).toFixed(1)+'%');
        h += '<div class="capa-div"><div class="capa-div-t">De dónde viene (o no viene) tu crecimiento</div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Lo que te pagan tus bienes <span class="capa-div-n2">'+fmt(m.rentaAnual||0)+' al año en arriendos, dividendos e intereses, sobre un patrimonio de '+fmt(m.brutoRef||0)+'</span></span><span class="capa-div-v">'+pp(m.rendRenta)+'</span></div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Lo que se valorizan <span class="capa-div-n2">'+(m.rendValorizacion==null?'aún no puedo calcularlo: falta con cuánto entró cada bien':'promedio anual de cuánto más valen hoy frente a su valor de entrada')+'</span></span><span class="capa-div-v">'+pp(m.rendValorizacion)+'</span></div>'
          + '<div class="capa-div-row tot"><span class="capa-div-l">Rendimiento total al año</span><span class="capa-div-v">'+pp(m.rendTotal)+'</span></div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Menos la inflación <span class="capa-div-n2">lo que sube la vida</span></span><span class="capa-div-v">−'+pp(m.inflacion)+'</span></div>'
          + '<div class="capa-div-row tot"><span class="capa-div-l">Lo que de verdad ganas en poder de compra</span><span class="capa-div-v">'+pp(m.rendReal)+'</span></div>'
          + (m.tasaAhorro!=null ? '<div class="capa-div-row"><span class="capa-div-l">Además, lo que le sumas de tu bolsillo <span class="capa-div-n2">de los '+fmt(m.ingMes||0)+' que te entran al mes le restamos '+fmt(m.gasMes||0)+' de gastos'+((m.cuotasMes||0)>0?' y '+fmt(m.cuotasMes)+' de cuotas de deuda':'')+': te quedan '+fmt(Math.round((m.aporteAnual||0)/12))+' al mes, o sea '+fmt(m.aporteAnual||0)+' al año</span></span><span class="capa-div-v">'+pp(m.crecPorAhorro)+'</span></div>' : '')
          + '</div>';
      }
      if(c.id==='proteccion' && c.metricas.sucesion){
        const m=c.metricas.sucesion;
        h += '<div class="capa-div"><div class="capa-div-t">Si tú faltas: cuánto habría que pagar</div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Impuesto de la herencia</span><span class="capa-div-v">'+capasMonto(m.impuestoHerencia)+'</span></div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Costo del proceso</span><span class="capa-div-v">'+capasMonto(m.costoProceso)+'</span></div>'
          + (m.vidaDependientes>0?'<div class="capa-div-row"><span class="capa-div-l">Sostenimiento de '+m.dependientes+' dependiente(s) durante el trámite</span><span class="capa-div-v">'+capasMonto(m.vidaDependientes)+'</span></div>':'')
          + '<div class="capa-div-row tot"><span class="capa-div-l">Se necesitaría</span><span class="capa-div-v">'+capasMonto(m.necesidadCaja)+'</span></div>'
          + '</div>';
        h += '<div class="capa-div"><div class="capa-div-t">Con qué contarían de inmediato</div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Seguros de vida con beneficiario designado <span class="capa-div-n2">'+(m.segurosDirectos>0?'la aseguradora paga directo, sin esperar la sucesión':'no tienes ninguno registrado')+'</span></span><span class="capa-div-v">'+capasMonto(m.segurosDirectos)+'</span></div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Retiro bancario permitido sin sucesión <span class="capa-div-n2">'+(m.accesoBancario>0?'la ley deja sacar hasta cierto tope de tus cuentas':'no tienes saldo libre en cuentas')+'</span></span><span class="capa-div-v">'+capasMonto(m.accesoBancario)+'</span></div>'
          + '<div class="capa-div-row"><span class="capa-div-l">Bienes fuera de la sucesión <span class="capa-div-n2">'+(m.fueraDeSucesion>0?'fiducia, holding o seguro de pensión: llegan directo a tus beneficiarios':'no tienes bienes en fiducia, holding ni seguros de pensión con beneficiario')+'</span></span><span class="capa-div-v">'+capasMonto(m.fueraDeSucesion)+'</span></div>'
          + '<div class="capa-div-row tot"><span class="capa-div-l">Total disponible rápido</span><span class="capa-div-v">'+capasMonto(m.disponibleRapido)+'</span></div>'
          + '</div>';
      }

    }
    h += '</div>';
    return h;
  }

  function renderCapasTablero(){
    const cont = document.getElementById('capas-tablero');
    if(!cont) return;
    let ev;
    try{ ev = evaluarPatrimonio(); }catch(e){ console.error('Evaluación patrimonial:', e); cont.innerHTML=''; return; }
    if(!ev || !ev.contexto || ev.contexto.cantidadActivos === 0){
      cont.innerHTML = '<div class="card"><div class="card-head"><div class="card-icon">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="12 2 22 8 12 14 2 8 12 2"/><polyline points="2 13 12 19 22 13"/><polyline points="2 17.5 12 23.5 22 17.5"/></svg>'
        + '</div><h3>Aún no hay nada que evaluar</h3></div>'
        + '<p class="summary-note" style="margin-top:0">Para medir tus cuatro capas necesito conocer tu patrimonio. Registra tus bienes en el <strong>Mapa Patrimonial</strong> y vuelve: aquí verás qué tan protegido, líquido, productivo y preparado está.</p>'
        + '<button class="btn btn-secondary" style="margin-top:12px" onclick="navigateTo(3)">Registrar mis activos</button></div>';
      return;
    }
    const nombres = {proteccion:'Protección', liquidez:'Liquidez', crecimiento:'Crecimiento', diversificacion:'Diversificación'};
    let h = '<div class="card capas-card">';
    h += '<div class="capas-resumen"><div class="capas-idx"><span class="v">'+ev.indice+'</span><span class="l">de 100</span></div>'
      + '<div class="capas-idx-txt">Tu punto más flojo es <strong>'+nombres[ev.eslabonDebil]+'</strong>: es lo primero que fallaría si algo sale mal, y por eso es donde más te conviene empezar.</div></div>';
    h += '<div class="capas-grid">' + ev.orden.map(k=>capaCardHtml(ev.capas[k])).join('') + '</div>';
    if((ev.compounding||[]).length){
      h += '<div class="capa-comp"><div class="capa-div-t">Riesgos que se suman entre capas</div><ul>'
        + ev.compounding.slice(0,4).map(x=>'<li><strong>'+escapeHtml(x.activo)+':</strong> '+x.detalle+'</li>').join('') + '</ul></div>';
    }
    h += '<p class="pf-note" style="margin-top:12px">Orientación educativa basada en lo que registraste. Los umbrales son configurables; valida las decisiones legales y tributarias con tu abogado y tu contador.</p>';
    h += '</div>';
    cont.innerHTML = h;
    cont.querySelectorAll('[data-capa]').forEach(b=>{
      b.addEventListener('click', ()=>{ const k=b.dataset.capa; if(capasAbiertas[k]) delete capasAbiertas[k]; else capasAbiertas[k]=true; renderCapasTablero(); });
    });
  }
  try{ window.renderCapasTablero = renderCapasTablero; }catch(e){}

  function ciiuTieneRiesgoProfesional(ciiuStr){
    if(!ciiuStr) return null;
    const digits = String(ciiuStr).replace(/[^0-9]/g,'').slice(0,4);
    if(digits.length < 2) return null;
    const p2 = digits.slice(0,2);
    for(const c of CIIU_RIESGO_PROFESIONAL){
      if(p2 === c.prefijo) return c;
    }
    return null;
  }

  // Fechas del Formulario 160 para PERSONAS NATURALES · 2026
  // Fuente: Decreto 2229/2023 modificatorio del Decreto 1625/2016, art. 1.6.1.13.2.26.
  // Personas naturales: 12 de agosto al 26 de octubre de 2026, según los dos últimos dígitos del NIT/cédula.
  // Se distribuye en 10 grupos de aproximadamente 5 días hábiles cada uno.
  function fechaFormulario160(digitos){
    const d = parseInt(String(digitos||'').replace(/[^0-9]/g,''), 10);
    if(!isFinite(d) || d < 0 || d > 99) return null;
    // Cronograma aproximado para personas naturales 2026:
    // Grupo 1 (01-10): 12-13 agosto  |  Grupo 2 (11-20): 14-19 agosto
    // Grupo 3 (21-30): 20-25 agosto  |  Grupo 4 (31-40): 26-31 agosto
    // Grupo 5 (41-50): 1-4 septiembre |  Grupo 6 (51-60): 5-10 septiembre
    // Grupo 7 (61-70): 11-16 septiembre | Grupo 8 (71-80): 17-22 septiembre
    // Grupo 9 (81-90): 23-28 septiembre | Grupo 10 (91-00): 29 sep - 26 oct
    const grupo = Math.floor(d / 10);   // 0..9
    // Ventana aproximada (día central del grupo)
    const ventanas = [
      { grupo:1, ini:'12 de agosto', fin:'13 de agosto' },
      { grupo:2, ini:'14 de agosto', fin:'19 de agosto' },
      { grupo:3, ini:'20 de agosto', fin:'25 de agosto' },
      { grupo:4, ini:'26 de agosto', fin:'31 de agosto' },
      { grupo:5, ini:'1 de septiembre', fin:'4 de septiembre' },
      { grupo:6, ini:'5 de septiembre', fin:'10 de septiembre' },
      { grupo:7, ini:'11 de septiembre', fin:'16 de septiembre' },
      { grupo:8, ini:'17 de septiembre', fin:'22 de septiembre' },
      { grupo:9, ini:'23 de septiembre', fin:'28 de septiembre' },
      { grupo:10, ini:'29 de septiembre', fin:'26 de octubre' }
    ];
    return ventanas[grupo] || null;
  }

  function formatearNumeroLista(n){
    const mapa = ['ninguno','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez'];
    return (n>=0 && n<=10) ? mapa[n] : String(n);
  }

  function sumaPatrimonio(activosNorm, filtro){
    return (activosNorm||[]).filter(filtro).reduce((s,a)=>s+(a.valor||0), 0);
  }


  /* ═════ MOTOR DE REGLAS ═════ */
  function evaluarEstructuraLegal(){
    const f = state.fiscal || {};
    const L = f.legal || {};
    const mapa = (typeof MapaPatrimonial !== 'undefined' && MapaPatrimonial.getData)
      ? MapaPatrimonial.getData()
      : { activosNormalizados:[], resumen:{ patrimonioBrutoCOP:0, patrimonioNetoCOP:0 }, activos:[], trm:{} };

    const activosNorm = mapa.activosNormalizados || [];
    const activosDetalle = mapa.activos || [];
    // Índice compartido por todas las reglas: id del activo → activo normalizado (con valor en COP).
    const normsById = new Map(activosNorm.map(a => [a._mapaId, a]));
    const patrimonioBruto = mapa.resumen.patrimonioBrutoCOP || 0;
    const smmlv = getSMMLV();
    const ingresoAnual = (typeof pfIngresoAnualBruto === 'function') ? pfIngresoAnualBruto() : 0;

    const activosFideicomiso = activosNorm.filter(a => a._estructuraLegal === 'Fideicomiso');

    const hallazgos = [];
    const palancas  = [];
    const H = (h) => hallazgos.push(h);
    const P = (p) => palancas.push(p);


    /* ── PROTECCIÓN ── */

    // R1 · Negocio productivo a nombre personal
    const negociosDirectos = activosDetalle.filter(a =>
      a.category === 'Empresarial' &&
      (a.legalStructure === 'Propiedad Directa' || !a.legalStructure)
    );
    negociosDirectos.forEach(neg => {
      const factorCOP = (neg.currency && neg.currency !== 'COP')
        ? ((mapa.trm||{})[neg.currency] || 0) : 1;
      const sh = mpShare(neg);
      const ingresoAnualCOP = (neg.monthlyIncome || 0) * 12 * factorCOP;
      const valorNegocioCOP = (neg.value || 0) * factorCOP * sh;
      const cumpleIngreso = ingresoAnualCOP > enPesos(LEGAL_UMBRALES.negocioIngresoAnualUVT);
      const cumpleValor   = valorNegocioCOP > (smmlv * LEGAL_UMBRALES.negocioValorSMMLV);
      const sev = (cumpleIngreso || cumpleValor) ? 'alta' : 'media';
      H({
        id:'R1_negocio_directo_'+neg.id,
        sev, categoria:'proteccion',
        titulo:'Tu negocio está a nombre personal',
        descripcion:'"'+(neg.description||neg.subtype||'Tu negocio')+'" está registrado a tu nombre, no como empresa. El problema: si el negocio recibe una demanda (un empleado que te demande, un cliente insatisfecho, la DIAN por impuestos, un proveedor por incumplimiento), pueden ir a cobrar contra tus bienes personales: tu casa, tu carro, tus cuentas de ahorro. Cuando el negocio es una SAS (Sociedad por Acciones Simplificada), tú como socio solo respondes hasta el monto que aportaste. Todo lo demás de tu patrimonio queda protegido.',
        activosAfectados:[neg.id],
        norma:'Ley 1258 de 2008, art. 1 (responsabilidad limitada de la SAS).',
        accionConcreta:'Constituye una SAS. Puedes hacerla tú solo (SAS unipersonal), tú eres el único socio. Pasos: (1) redactas los estatutos (hay modelos gratis en Cámara de Comercio), (2) los registras en la Cámara de Comercio de tu ciudad, (3) te dan el NIT, (4) empiezas a facturar desde la SAS. Necesitarás un contador porque la SAS lleva contabilidad separada.',
        profesionalRequerido:'abogado o directamente Cámara de Comercio',
        estimacionCosto:'Constitución en Cámara de Comercio: entre $600.000 y $1.200.000 según el capital. Mantenimiento anual (contador + renovación): entre $3 y $7 millones.',
        cta:'Ver cuánto ahorrarías tributariamente con una SAS',
        ctaLink: 11
      });
    });

    // R2 · Ingreso pasivo relevante a nombre personal
    const rentasPasivasDirectas = activosDetalle.filter(a =>
      (a.category === 'Inmueble' || a.category === 'Alternativo') &&
      (a.legalStructure === 'Propiedad Directa' || !a.legalStructure) &&
      (a.monthlyIncome || 0) > 0
    );
    rentasPasivasDirectas.forEach(act => {
      const factorCOP = (act.currency && act.currency !== 'COP')
        ? ((mapa.trm||{})[act.currency] || 0) : 1;
      const ingresoAnualCOP = (act.monthlyIncome || 0) * 12 * factorCOP;
      if(ingresoAnualCOP <= enPesos(LEGAL_UMBRALES.ingresoPasivoRelevanteUVT * 12)) return;
      H({
        id:'R2_renta_pasiva_'+act.id,
        sev:'media', categoria:'vehiculo',
        titulo:'Ingresos por arriendo altos a tu nombre',
        descripcion:'"'+(act.description||act.subtype)+'" te genera '+fmt(ingresoAnualCOP)+' al año en arriendos u otros ingresos. Como está a tu nombre, esos ingresos suman a tu declaración de renta personal y pueden pagar hasta el 39% de impuesto según tu escala de ingresos. Si en cambio el bien fuera de una SAS, esa empresa pagaría 35% fijo y tú solo pagarías impuesto extra cuando decidas sacar el dinero como dividendos. Para ingresos altos y sostenidos, la SAS suele ahorrar impuestos.',
        activosAfectados:[act.id],
        norma:'Arts. 240 y 242 del Estatuto Tributario (tarifas de renta y dividendos).',
        accionConcreta:'Antes de hacer nada, corre el simulador de SAS que está dentro del Perfil Fiscal con este ingreso específico. Ahí verás si te conviene o no: para arriendos muy altos suele ganar la SAS; para montos medianos depende de si necesitas retirar el dinero o dejarlo reinvertido en la empresa.',
        profesionalRequerido:'contador',
        estimacionCosto:'Crear la SAS y primer año: entre $5 y $8 millones. Años siguientes: entre $4 y $6 millones al año.',
        cta:'Comparar en el simulador SAS',
        ctaLink: 11
      });
    });

    // R3 · Actividad de riesgo profesional sin estructura societaria
    // Ya no habla de la póliza RC (eso lo cubre R23). Aquí el foco es la SAS como segunda capa.
    const riesgoProf = ciiuTieneRiesgoProfesional(f.ciiu);
    const todoADirecta = patrimonioBruto > 0 &&
      sumaPatrimonio(activosNorm, a => a._estructuraLegal === 'Propiedad Directa' || !a._estructuraLegal) / patrimonioBruto > 0.90;
    if(riesgoProf && todoADirecta && patrimonioBruto > smmlv * 100){
      // Si ya tiene RC declarada, la severidad baja porque tiene una capa protectora
      const yaTieneRC = L.coberturas && L.coberturas.rcProfesional && L.coberturas.rcProfesional.tiene === true;
      const sev = yaTieneRC ? 'media' : 'alta';
      H({
        id:'R3_riesgo_profesional',
        sev, categoria:'proteccion',
        titulo:'Tu profesión te expone a demandas y todo lo tienes a nombre personal',
        descripcion:'Trabajas en '+riesgoProf.desc+', un área donde los clientes pueden demandarte por errores profesionales: un tratamiento médico que salió mal, un diseño con fallas, un dictamen contable incorrecto, un edificio con problemas de construcción. Como más del 90% de tu patrimonio está a nombre personal, si te demandan y te condenan, el juez puede ordenar embargar tu casa, tus cuentas, tus carros — todo. '+(yaTieneRC ? 'Ya tienes póliza de responsabilidad civil profesional (bien hecho), pero esa cobertura tiene un tope, una vez agotado el resto lo pagas tú. Falta la segunda capa: separar la actividad profesional en una SAS.' : 'No tienes póliza de responsabilidad civil profesional ni estructura societaria — cero capas entre tu actividad y tu patrimonio familiar.'),
        activosAfectados:[],
        norma:'Código Civil arts. 2341 a 2360 (responsabilidad por daños) · Ley 1480 de 2011 (protección al consumidor).',
        accionConcreta:'Blíndate en dos capas complementarias: (1) '+(yaTieneRC ? 'confirma que la suma asegurada de tu RC sea suficiente (referencia: 3 a 5 años de facturación)' : 'contrata una <strong>póliza de responsabilidad civil profesional</strong> — cotiza en Sura, Bolívar, Liberty; el costo depende de tu profesión y facturación')+'. (2) Factura a través de una SAS para separar la actividad profesional del patrimonio familiar. Nota importante: la SAS te protege de las deudas del negocio, pero si tú personalmente cometes un error profesional grave, la responsabilidad profesional te persigue a ti como persona — por eso las dos capas son complementarias.',
        profesionalRequerido:'asesor de seguros + abogado',
        estimacionCosto:'Póliza de responsabilidad civil profesional: entre 0,5% y 2% de tu ingreso anual. SAS: $5 millones para crearla + entre $4 y $6 millones al año de mantenimiento.'
      });
    }

    // R4 · Aval a terceros
    if(L.avalesTerceros && L.avalesTerceros.tiene && L.avalesTerceros.monto > 0){
      const pctPat = patrimonioBruto > 0 ? L.avalesTerceros.monto / patrimonioBruto : 0;
      const sev = pctPat > LEGAL_UMBRALES.avalRelevantePctPatrimonio ? 'alta' : 'media';
      H({
        id:'R4_aval_terceros',
        sev, categoria:'proteccion',
        titulo:'Firmaste como aval de una deuda de otra persona',
        descripcion:'Registraste un aval por '+fmt(L.avalesTerceros.monto)+' ('+Math.round(pctPat*100)+'% de tu patrimonio bruto). Esto significa: si la persona o empresa a la que respaldaste deja de pagar, el banco te cobra <strong>directamente a ti</strong> todo el saldo. No tiene que buscar primero al deudor principal ni agotar sus bienes: te lo cobra a ti de una vez, incluso puede embargar tus bienes. En la mayoría de préstamos personales, pagarés y letras (que se llama "aval mercantil") funciona así, sin que puedas exigir que primero le cobren al deudor.',
        activosAfectados:[],
        norma:'Código de Comercio art. 636 · Código Civil arts. 2361 y ss.',
        accionConcreta:'Toma tres acciones: (1) Pide al banco copia del documento que firmaste — lee si dice "aval" o "fianza"; con "fianza civil" puedes exigir que primero cobren al deudor. (2) Habla con la persona a la que respaldaste: pídele que en el próximo abono grande o al final del crédito solicite quitarte del papel. (3) Si el aval es muy grande, considera pedirle al deudor principal que ponga garantías reales (una hipoteca, una prenda) para no cargar tú con todo el riesgo. Y muy importante: nunca firmes avales sin leer el documento completo.',
        profesionalRequerido:'abogado (si el aval es grande o complejo)'
      });
    }

    // R5 · Pleito vigente como demandado
    if(L.pleitosVigentes && L.pleitosVigentes.tieneComoDemandado){
      H({
        id:'R5_pleito_demandado',
        sev:'alta', categoria:'proteccion',
        titulo:'Tienes un proceso judicial abierto en tu contra',
        descripcion:'Te están reclamando '+fmt(L.pleitosVigentes.montoPretensiones||0)+' en un proceso judicial. Mientras el proceso no termine, el juez puede ordenar embargar tus bienes como medida preventiva (embargar tu cuenta bancaria, tu apartamento, tu carro) para asegurar que si pierdes, haya con qué pagar. <strong>Advertencia importante:</strong> si ahora intentas traspasar bienes a familiares, venderlos a precio muy bajo o "esconderlos" en una empresa nueva, el juez puede anular esas operaciones porque la ley las considera fraude a acreedores. No hagas eso.',
        activosAfectados:[],
        norma:'Código Civil art. 2491 (acciones que se pueden anular por fraude) · Código General del Proceso arts. 590 y siguientes (embargos preventivos).',
        accionConcreta:'Enfoca toda la energía en <strong>defender bien el proceso</strong>, no en mover bienes. Lo que sí puedes y debes hacer: (1) contratar un buen abogado especializado en el tipo de proceso; (2) tener liquidez disponible por si te obligan a consignar mientras se resuelve; (3) contratar seguros nuevos si aún no los tienes (esto sí es válido, siempre lo ha sido); (4) evitar hacer donaciones o traspasos gratuitos hasta que el proceso termine.',
        profesionalRequerido:'abogado especialista en el tipo de proceso'
      });
    }


    /* ── SUCESIÓN ── */

    const totalDependientes = (L.hijosMenores||0) + (L.hijosMayoresDependientes||0) + (L.otrosDependientes||0);
    const hayEmpresarialAlto = activosNorm.some(a =>
      a._categoria === 'Empresarial' && a.valor > smmlv * 300
    );

    // R6 · Sin testamento
    const necesitaTestamento =
      (patrimonioBruto > smmlv * LEGAL_UMBRALES.patrimonioSinTestamentoSMMLV) ||
      (totalDependientes > 0) ||
      hayEmpresarialAlto;

    if(necesitaTestamento && L.testamento && L.testamento.tiene === false){
      const sev = hayEmpresarialAlto ? 'alta' : 'media';
      const razones = [];
      if(patrimonioBruto > smmlv * LEGAL_UMBRALES.patrimonioSinTestamentoSMMLV) razones.push('patrimonio de '+fmt(patrimonioBruto));
      if(totalDependientes > 0) razones.push(formatearNumeroLista(totalDependientes)+' persona'+(totalDependientes>1?'s':'')+' dependiente'+(totalDependientes>1?'s':''));
      if(hayEmpresarialAlto) razones.push('participación empresarial relevante');
      H({
        id:'R6_sin_testamento',
        sev, categoria:'sucesion',
        titulo:'No tienes testamento — la ley decidiría por ti',
        descripcion:'Con '+razones.join(', ')+', si te faltas hoy sin testamento, la ley reparte tus bienes con reglas fijas que quizá no coinciden con lo que tú querrías: primero se dividen en partes iguales entre tus hijos (si un hijo faltó antes, sus hijos - tus nietos - reciben su parte). Si no tienes hijos, van a tus padres y cónyuge. Si tampoco, a tus hermanos. Aunque no puedes desheredar a hijos, padres o cónyuge (la ley les garantiza mínimo el 50% de tu herencia), sí puedes con el otro 50% decidir cosas importantes: dejarle algo específico a alguien (una amiga, una fundación), nombrar quién administra la herencia mientras se resuelve, elegir tutor para tus hijos menores, y darle instrucciones sobre tu negocio.',
        activosAfectados:[],
        norma:'Código Civil arts. 1045 y siguientes (herencia sin testamento) · arts. 1226 y siguientes (derechos protegidos de familiares).',
        accionConcreta:'Ve a cualquier notaría en tu ciudad y pide una cita para hacer un <strong>testamento abierto</strong>, que es el más común y económico. Lleva tu cédula, una lista de tus bienes principales y a quiénes vas a dejar qué. El notario lo redacta ahí mismo, tú lo firmas con dos testigos, y en el mismo día queda protocolizado en la notaría. Puedes cambiarlo o revocarlo cuando quieras — el testamento más reciente es el que vale.',
        profesionalRequerido:'notario (para casos simples) · abogado (si tienes empresa o patrimonio complejo)',
        estimacionCosto:'Testamento abierto en notaría: entre $200.000 y $500.000, según la ciudad y complejidad. Para patrimonios altos o con empresa, sumar honorarios de abogado.'
      });

      P({
        id:'P_testamento',
        titulo:'Otorgar testamento',
        descripcion:'La acción con mayor impacto en relación con su costo. Trámite corto en notaría, muy económico, y evita que la ley reparta tus bienes con reglas fijas que quizá no coinciden con lo que tú quieres. Además te da control sobre asignaciones específicas.',
        estimacionCosto:'$200.000 a $500.000',
        ctaLink:null
      });
    }

    // R7 · Testamento desactualizado
    if(L.testamento && L.testamento.tiene && L.testamento.anioOtorgamiento){
      const anios = new Date().getFullYear() - parseInt(L.testamento.anioOtorgamiento, 10);
      if(anios > LEGAL_UMBRALES.testamentoAntiguedadAnios || L.testamento.revisadoTrasCambios === false){
        H({
          id:'R7_testamento_viejo',
          sev:'media', categoria:'sucesion',
          titulo:'Tu testamento tiene '+anios+' años sin revisar',
          descripcion:'El testamento que vale es el más reciente que hayas firmado. Pero si tu vida cambió en estos '+anios+' años (te casaste, tuviste hijos, compraste una casa, vendiste otra, montaste una empresa, se divorciaste), lo más probable es que el testamento actual ya no refleje lo que quieres. Puede tener asignaciones vacías (dejarle a alguien un carro que ya vendiste) o dejar bienes nuevos sin repartir. Cuando se abra tu sucesión, esos vacíos generan conflictos entre herederos.',
          activosAfectados:[],
          norma:'Código Civil art. 1055 (un testamento nuevo revoca los anteriores).',
          accionConcreta:'Ve a cualquier notaría (no tiene que ser la misma donde hiciste el original) y otorga un testamento nuevo con la información actualizada. El nuevo automáticamente anula al anterior en lo que sea diferente. <strong>No basta con romper el papel viejo</strong>: si el notario tiene copia protocolizada, sigue teniendo valor mientras no otorgues uno nuevo.',
          profesionalRequerido:'notario',
          estimacionCosto:'Entre $200.000 y $500.000, similar al testamento original.'
        });
      }
    }

    // R8 · Sociedad conyugal con bienes altos "solo tuyos"
    if(L.estadoCivil === 'casado' && L.regimenConyugal === 'sociedad_conyugal'){
      const bienesAltos = activosDetalle.filter(a => {
        if(a.esCompartido) return false;
        const nrm = normsById.get(a.id);
        const valCOP = nrm ? nrm.valor : 0;
        return valCOP > smmlv * 100;
      });
      if(bienesAltos.length > 0){
        const listaBienesConyugal = bienesAltos.map(a => {
          const nrm = normsById.get(a.id);
          const valCOP = nrm ? nrm.valor : 0;
          const nombre = a.description || a.subtype || 'Bien sin nombre';
          return '<li><strong>'+nombre+'</strong> — '+fmt(valCOP)+'</li>';
        }).join('');
        H({
          id:'R8_sociedad_conyugal',
          sev:'info', categoria:'sucesion',
          titulo:'Estás casado y hay bienes que probablemente son de los dos',
          descripcion:'Marcaste estos bienes de alto valor como "solo tuyos":<ul class="leg-hall-list">'+listaBienesConyugal+'</ul>Pero en tu régimen (sociedad conyugal, el estándar en Colombia), <strong>los bienes que se compraron durante el matrimonio son de los dos al 50%</strong>, aunque estén a nombre de uno solo. Las únicas excepciones: bienes que ya tenías antes de casarte, bienes que heredaste, o regalos que te hicieron directamente a ti. Cuando se liquide la sociedad (por divorcio o fallecimiento), tu pareja tiene derecho al 50% de esos bienes ANTES de que se reparta la herencia.',
          activosAfectados: bienesAltos.map(b=>b.id),
          norma:'Código Civil arts. 1781, 1795 y siguientes.',
          accionConcreta:'Confirma cómo compraste cada bien de alto valor. Si fue con dinero anterior al matrimonio, con herencia o con donación directa a ti, es un bien propio (no compartido) — reúne los documentos que lo prueben (extractos bancarios, escrituras, testamentos, contratos de donación). Si te casaste después de comprarlo, mucho mejor. Si quieres separar bienes hacia adelante, se pueden firmar "capitulaciones" en notaría, pero solo aplican desde la fecha en que se firmen.',
          profesionalRequerido:'notario (para capitulaciones)',
          estimacionCosto:'Capitulaciones en notaría: $300.000 a $800.000. Solo con documentar el origen de los bienes: sin costo, solo tiempo.'
        });
      }
    }

    // R9 · Unión libre con más de 2 años
    if(L.estadoCivil === 'union_marital' && L.anioMatrimonioUnion){
      const anios = new Date().getFullYear() - parseInt(L.anioMatrimonioUnion, 10);
      if(anios >= LEGAL_UMBRALES.umhPresuncionAnios){
        H({
          id:'R9_umh_presuncion',
          sev:'media', categoria:'sucesion',
          titulo:'Llevas '+anios+' años en unión libre — hay derechos patrimoniales',
          descripcion:'La ley colombiana dice que después de dos años de convivencia estable, ustedes forman lo que se llama "sociedad patrimonial": los bienes que compraron en ese tiempo son de los dos al 50%, aunque estén a nombre de uno solo. La diferencia con estar casados: <strong>en unión libre, para hacer valer ese derecho hay que probarlo</strong>, ya sea con una declaración conjunta en notaría o con un proceso ante juez. Muchas parejas descubren esto solo cuando hay problemas (una separación, un fallecimiento) y ahí ya es tarde.',
          activosAfectados:[],
          norma:'Ley 54 de 1990, arts. 1 y 2 (modificada por Ley 979 de 2005).',
          accionConcreta:'Si están de acuerdo, es mejor formalizar ahora: vayan juntos a una notaría y firmen una declaración de unión marital y sociedad patrimonial. Es un trámite corto (una tarde) y evita que en el futuro alguno tenga que hacer un proceso judicial largo. Si prefieren no formalizar, guarden pruebas de la convivencia y sus fechas (contratos de arriendo, cuentas conjuntas, testigos, fotos con fechas).',
          profesionalRequerido:'notario',
          estimacionCosto:'Declaración notarial: entre $100.000 y $300.000.'
        });
      }
    }

    // R10 · Seguros con beneficiarios "legales"
    const seguros = L.segurosVida || [];
    const segurosBenLegales = seguros.filter(s => s.beneficiarios === 'legales');
    if(segurosBenLegales.length > 0){
      const suma = segurosBenLegales.reduce((s,x)=>s+(x.sumaAsegurada||0),0);
      H({
        id:'R10_seguro_ben_legales',
        sev:'info', categoria:'sucesion',
        titulo:'Tus seguros no tienen personas específicas como beneficiarios',
        descripcion:'Tienes '+fmt(suma)+' en seguros donde no elegiste tú quién recibe el dinero, sino que dejaste "beneficiarios de ley" — es decir, quien la ley determine según las reglas de la herencia. El problema: si tú faltas, ese dinero <strong>no llega directo a nadie</strong>; entra a la masa de la herencia, se pelea entre los herederos, se demora meses en repartirse, y puede terminar pagando deudas tuyas antes de llegar a tu familia. En cambio, si designas personas específicas (por ejemplo: 60% a tu esposa, 40% a tu hijo), el dinero les llega directo en pocas semanas, no entra a la herencia, y no responde por tus deudas.',
        activosAfectados:[],
        norma:'Código de Comercio arts. 1141 y 1142 · Art. 303-1 del Estatuto Tributario (exención tributaria hasta 3.250 UVT).',
        accionConcreta:'Llama o escribe a cada aseguradora y pide el formato de "designación de beneficiarios". Es un trámite gratuito y toma minutos. Nombra personas específicas con nombre, cédula y porcentaje que recibe cada una. Puedes cambiarlo cuando quieras. <strong>Consejo importante:</strong> si algún beneficiario es menor de edad, considera dejar el dinero en un fideicomiso que lo administre hasta que cumpla cierta edad — así evitas que un tutor tenga control total del dinero.',
        profesionalRequerido:null,
        estimacionCosto:'Gratuito. Se hace directamente con la aseguradora, sin intermediarios.'
      });
    }

    // R11 · Empresa relevante + dependientes
    const activosEmpresarialAlto = activosNorm.filter(a => a._categoria === 'Empresarial' && a.valor > smmlv * 300);
    if(activosEmpresarialAlto.length > 0 && totalDependientes > 0){
      const totalEmpresarial = activosEmpresarialAlto.reduce((s,a) => s + a.valor, 0);
      H({
        id:'R11_empresa_familiar',
        sev:'info', categoria:'sucesion',
        titulo:'Tienes empresa relevante y dependientes: define quién la maneja si tú faltas',
        descripcion:'Tu participación en empresas suma '+fmt(totalEmpresarial)+' y tienes '+totalDependientes+' persona'+(totalDependientes>1?'s':'')+' que dependen económicamente de ti. Sin reglas escritas sobre qué pasa con la empresa si tú faltas, típicamente ocurren tres problemas: (1) el negocio se paraliza mientras los herederos definen quién manda; (2) tus herederos y socios pueden no coincidir en visión del negocio (uno quiere vender, otro seguir); (3) hay disputas sobre cuánto vale la empresa a la hora de repartirla. Un acuerdo escrito con anticipación evita todo esto.',
        activosAfectados: activosEmpresarialAlto.map(a=>a._mapaId),
        norma:'Ley 1258 de 2008 (SAS) arts. 13 y 22 · Código de Comercio arts. 397 y siguientes.',
        accionConcreta:'Tres acciones concretas: (1) Revisa los estatutos actuales de la empresa — busca si dicen algo sobre qué pasa cuando un socio fallece (derecho de preferencia para los demás socios, cómo se calcula el precio de sus acciones). (2) Si tienes socios, firmen un "acuerdo de accionistas" que defina las reglas por escrito: quién administra, cómo se valora la empresa, qué opciones tienen los herederos, si pueden vender a terceros. (3) Si eres 100% dueño, en tu testamento deja instrucciones específicas: quién administra mientras se reparte, en qué precio se valora la empresa, si prefieres que se venda o siga operando.',
        profesionalRequerido:'abogado con experiencia en derecho societario y empresa familiar',
        estimacionCosto:'Acuerdo de accionistas: $2 a $8 millones según complejidad. Reforma estatutaria: $1 a $3 millones.'
      });
    }


    /* ── CUMPLIMIENTO ── */

    // R12 · Formulario 160 · Activos en el exterior
    const valorExterior = (f.exterior && f.exterior.tiene) ? (f.exterior.valor || 0) : 0;
    const topeExterior = enPesos(LEGAL_UMBRALES.exteriorUVT);
    if(valorExterior > topeExterior){
      const cE = L.cumplimientoExterior || {};
      const noPresentado = cE.formulario160Presentado === false;
      const noSabe       = cE.formulario160Presentado === null || cE.formulario160Presentado === undefined;
      const sev = noPresentado ? 'alta' : (noSabe ? 'media' : 'ok');
      const fecha = fechaFormulario160(f.digitosCedula || f.digitosNit);
      const fechaTxt = fecha
        ? ('entre el '+fecha.ini+' y el '+fecha.fin+' de 2026 (grupo '+fecha.grupo+' según los dos últimos dígitos de tu cédula)')
        : 'entre el 12 de agosto y el 26 de octubre de 2026, según los dos últimos dígitos de tu cédula';
      H({
        id:'R12_formulario_160',
        sev, categoria:'cumplimiento',
        titulo: noPresentado ? 'Formulario 160 no presentado' : (noSabe ? 'Verifica tu Formulario 160' : 'Formulario 160 al día'),
        descripcion: sev === 'ok'
          ? 'Confirmaste que presentaste la declaración anual de activos en el exterior del año pasado. Se presenta cada año, y toma como referencia lo que tenías fuera del país el 1 de enero, siempre que la suma supere '+fmt(topeExterior)+'.'
          : 'Tienes '+fmt(valorExterior)+' fuera del país, más del tope legal de '+fmt(topeExterior)+'. Debes presentar el Formulario 160 (declaración de activos en el exterior) cada año, es diferente de tu declaración de renta. Si no lo presentas, la sanción es del 0,5% del valor de esos activos por cada mes de retraso, con tope del 10%. Además, la DIAN recibe información de tus cuentas del exterior automáticamente por convenios internacionales (CRS y FATCA), así que probablemente ya saben que las tienes.',
        activosAfectados:[],
        norma:'Art. 607 del Estatuto Tributario · Sanciones art. 641 ET.',
        accionConcreta:'Entra al portal de la DIAN con tu firma electrónica y busca "Formulario 160". Reporta cada cuenta o inversión con su valor a 1 de enero. Fecha límite: '+fechaTxt+'. Si ya estás atrasado, preséntalo cuanto antes: la sanción crece cada mes.',
        profesionalRequerido:'contador',
        estimacionCosto:'La declaración es gratuita. Si contratas contador para armarla: $300.000–$1.000.000.'
      });
    }

    // R13 · ECE
    const negociosExterior = activosDetalle.filter(a => {
      if(a.category !== 'Empresarial') return false;
      if(!a.location || a.location === 'Colombia') return false;
      if(a.rolEmpresarial === 'Propietario único') return true;
      if(a.rolEmpresarial === 'Representante legal') return true;
      if(a.rolEmpresarial === 'Socio y representante legal') return true;
      if((a.rolEmpresarial === 'Socio' || a.rolEmpresarial === 'Accionista')
         && (a.porcentajePropio || 100) > 50) return true;
      if((L.cumplimientoExterior||{}).tieneVehiculoECE) return true;
      return false;
    });
    negociosExterior.forEach(neg => {
      H({
        id:'R13_ece_'+neg.id,
        sev:'alta', categoria:'cumplimiento',
        titulo:'Eres dueño mayoritario de una empresa fuera de Colombia',
        descripcion:'Tu participación en "'+(neg.description||neg.subtype)+'" ('+neg.location+') como '+(neg.rolEmpresarial||'controlante')+' te pone en un régimen especial de la DIAN. La regla dice: las <strong>ganancias pasivas</strong> de esa empresa extranjera (intereses ganados, dividendos que recibe, arriendos, regalías, ganancias por venta de sus inversiones) se consideran tuyas directamente en Colombia el mismo año en que la empresa las obtiene, aunque no te hayan pagado nada. Las ganancias de la operación normal del negocio (vender productos o servicios) sí escapan a esta regla. Muchos colombianos con empresas en Delaware, Panamá, Uruguay, España, Miami, están en esta situación y no lo saben.',
        activosAfectados:[neg.id],
        norma:'Arts. 882 a 893 del Estatuto Tributario.',
        accionConcreta:'Con un contador que sepa de tributación internacional: (1) toma los estados financieros del último año de la sociedad extranjera y clasifica sus ingresos entre "operativos" (venta de bienes/servicios propios del negocio) y "pasivos" (inversiones, intereses, dividendos, arriendos, regalías). (2) Los pasivos, reportarlos como renta tuya en Colombia. (3) Si es tu primera vez y llevas años con la empresa, revisa años anteriores para hacer correcciones voluntarias antes de que la DIAN te lo detecte por convenios internacionales.',
        profesionalRequerido:'contador con experiencia en tributación internacional',
        estimacionCosto:'Análisis inicial y declaración: entre $2 y $5 millones según qué tan compleja sea la empresa.'
      });
    });

    // R14 · Restricciones legales
    const restringidosNorm = activosNorm.filter(a => a.restringido);
    const restringidos = activosDetalle.filter(a => a.restringidoLegal);
    if(restringidos.length > 0){
      const sumaRestringida = restringidosNorm.reduce((s,a) => s + (a.valor||0), 0);
      const pct = patrimonioBruto > 0 ? sumaRestringida / patrimonioBruto : 0;
      const sev = pct > 0.20 ? 'alta' : 'media';
      // Lista detallada de bienes con nombre y valor en COP (usa normsById global)
      const listaBienes = restringidos.map(a => {
        const nrm = normsById.get(a.id);
        const valCOP = nrm ? nrm.valor : 0;
        const nombre = a.description || a.subtype || 'Bien sin nombre';
        return '<li><strong>'+nombre+'</strong> — '+fmt(valCOP)+'</li>';
      }).join('');
      H({
        id:'R14_restricciones',
        sev, categoria:'cumplimiento',
        titulo:'Tienes bienes con problemas legales pendientes',
        descripcion:formatearNumeroLista(restringidos.length)+' de tus bienes tiene'+(restringidos.length>1?'n':'')+' algún problema activo (embargo, pleito judicial, herencia sin repartir o hipoteca/prenda pendiente) — suman '+fmt(sumaRestringida)+' ('+Math.round(pct*100)+'% de tu patrimonio):<ul class="leg-hall-list">'+listaBienes+'</ul>Estos bienes siguen siendo tuyos y pagan impuestos como si los usaras normalmente, pero <strong>no puedes venderlos, hipotecarlos ni disponer libremente de ellos</strong> hasta resolver el problema. Si son una herencia sin repartir, además vas a pagar impuesto de ganancia ocasional cuando finalmente te los asignen.',
        activosAfectados: restringidos.map(a=>a.id),
        norma:'Código General del Proceso arts. 593 a 606 (embargos) · Código Civil arts. 1008 y siguientes (herencia).',
        accionConcreta:'Para cada bien con problema: (1) Identifica qué proceso lo generó (juzgado, número de proceso, año) — puedes consultarlo en la Rama Judicial en línea con tu cédula. (2) Si es una herencia pendiente, revisa en qué etapa está y qué falta para la adjudicación. (3) Si el embargo es antiguo por una deuda que ya pagaste, ve al juzgado a solicitar el desembargo — muchas veces la orden nunca se cumplió aunque la deuda esté saldada. (4) Prioriza resolver esto: sin resolver, ese porcentaje de tu patrimonio está "congelado" y no puedes usarlo para nada.',
        profesionalRequerido:'abogado (según el tipo de problema)'
      });
    }


    /* ── CONCENTRACIÓN ── */

    // R16 · Concentración en propiedad directa
    if(patrimonioBruto > 0){
      const sumaDirecta = sumaPatrimonio(activosNorm, a =>
        a._estructuraLegal === 'Propiedad Directa' || !a._estructuraLegal);
      const pctDirecta = sumaDirecta / patrimonioBruto;
      if(pctDirecta > LEGAL_UMBRALES.concentracionDirectaPct && patrimonioBruto > smmlv * 200){
        H({
          id:'R16_concentracion_directa',
          sev:'media', categoria:'concentracion',
          titulo:'Casi todo tu patrimonio está a tu nombre personal ('+Math.round(pctDirecta*100)+'%)',
          descripcion:'Tienes '+fmt(sumaDirecta)+' ('+Math.round(pctDirecta*100)+'%) directamente a tu nombre. El problema con esta concentración: <strong>todo el patrimonio queda expuesto al mismo tiempo</strong> ante cualquier problema personal — una demanda contra ti, un embargo por una deuda personal, la liquidación de la sociedad conyugal en un divorcio, o la sucesión completa el día que faltes. Estructuras como SAS, seguros de vida y fideicomisos permiten diversificar ese riesgo sin cambiar quién es el dueño económico real de los bienes.',
          activosAfectados:[],
          norma:null,
          accionConcreta:'No hagas cambios grandes de una vez, cada estructura tiene costos fijos. Empieza por los 2 o 3 bienes más grandes y evalúa por separado: (1) si tienes un negocio → SAS operativa; (2) si tienes un inmueble que arriendas → SAS inmobiliaria; (3) si tienes inversiones financieras grandes → cartera colectiva o SAS holding. Corre los números primero: el ahorro tributario o la protección deben justificar el costo anual de mantener cada estructura.',
          profesionalRequerido:'asesor patrimonial + contador',
          estimacionCosto:'Cada estructura nueva: entre $4 y $8 millones al año de mantenimiento (contador, renovación, gastos de sociedad).'
        });
      }
    }

    // R17 · Concentración en un único vehículo societario
    if(patrimonioBruto > 0){
      const sumaEnSociedades = sumaPatrimonio(activosNorm, a =>
        a._estructuraLegal === 'Sociedad Comercial' || a._estructuraLegal === 'LLC');
      const pctSociedades = patrimonioBruto > 0 ? sumaEnSociedades / patrimonioBruto : 0;
      if(pctSociedades > LEGAL_UMBRALES.concentracionVehiculoPct && sumaEnSociedades > smmlv * 500){
        H({
          id:'R17_concentracion_vehiculo',
          sev:'info', categoria:'concentracion',
          titulo:'Casi todo tu patrimonio está en una misma empresa',
          descripcion:'El '+Math.round(pctSociedades*100)+'% de tu patrimonio ('+fmt(sumaEnSociedades)+') está en empresas. Si son la misma empresa, cualquier problema que le pase (demanda contra la sociedad, sanción DIAN, dificultad operativa) afecta al mismo tiempo todos los bienes que hay dentro. La práctica estándar en patrimonios grandes es separar la <strong>SAS operativa</strong> (la que factura, contrata empleados, hace el negocio del día a día) de una <strong>SAS holding</strong> (que solo es dueña de bienes: inmuebles, inversiones, participaciones). Así, si la operativa tiene problemas, la holding no se ve afectada.',
          activosAfectados:[],
          norma:'Art. 246-1 del Estatuto Tributario (los dividendos que la operativa le pasa a la holding no pagan impuesto extra).',
          accionConcreta:'Si hoy tienes UNA sola SAS haciendo todo (operar + guardar activos), evalúa con tu contador: mantén la operativa como está, crea una SAS holding aparte, y transfiere a la holding los activos no operativos (inmuebles arrendados, inversiones). El costo tributario de trasladar los activos hay que evaluarlo antes: si el patrimonio va a crecer, el movimiento se justifica; si no crecerá mucho más, quizá no.',
          profesionalRequerido:'abogado societario + contador tributarista',
          estimacionCosto:'Reestructuración con aporte de bienes: entre $10 y $30 millones según patrimonio y complejidad del traslado.'
        });
      }
    }

    // R18 · Copropiedad de alto valor (usa normsById global)
    const copropiedades = activosDetalle.filter(a => {
      if(!a.esCompartido) return false;
      const nrm = normsById.get(a.id);
      return nrm && nrm.valor > smmlv * LEGAL_UMBRALES.copropiedadValorSMMLV;
    });
    if(copropiedades.length > 0){
      const listaCoprop = copropiedades.map(a => {
        const nrm = normsById.get(a.id);
        const valCOP = nrm ? nrm.valor : 0;
        const pctTuyo = a.porcentajePropio || 50;
        const nombre = a.description || a.subtype || 'Bien sin nombre';
        return '<li><strong>'+nombre+'</strong> — valor total '+fmt(valCOP)+' (tu parte: '+pctTuyo+'%, es decir '+fmt(valCOP * pctTuyo / 100)+')</li>';
      }).join('');
      H({
        id:'R18_copropiedad',
        sev:'info', categoria:'concentracion',
        titulo:'Tienes bienes de alto valor compartidos con otras personas',
        descripcion:'Estos son los bienes compartidos que detectamos:<ul class="leg-hall-list">'+listaCoprop+'</ul>Sin un acuerdo escrito, cada decisión sobre el bien (venderlo, arrendarlo, hipotecarlo, hacer mejoras) requiere el acuerdo de todos los dueños. Peor aún: <strong>cualquiera de los copropietarios puede pedir en cualquier momento que el bien se divida o se venda</strong>, y si no llegan a acuerdo, un juez ordena venderlo. Esto genera conflictos frecuentes en herencias entre hermanos, negocios entre socios y familias con propiedades compartidas.',
        activosAfectados: copropiedades.map(c=>c.id),
        norma:'Código Civil arts. 2334 a 2340 (bienes comunes).',
        accionConcreta:'Reúnete con los demás dueños y firmen un acuerdo escrito (ante notaría o con firmas autenticadas) que defina mínimo 4 puntos: (1) quién administra el día a día y cómo se distribuyen las rentas; (2) cómo se toman las decisiones importantes; (3) qué pasa si uno quiere vender su parte (derecho de preferencia para los demás); (4) qué pasa si uno de ustedes fallece.',
        profesionalRequerido:'abogado',
        estimacionCosto:'Redacción del acuerdo: entre $500.000 y $2 millones según cuánta gente y qué tan complejo sea.'
      });
    }


    /* ── PALANCAS Y OTRAS SUGERENCIAS ── */

    // R21 · Iliquidez con dependientes → seguro de vida
    const activosLiquidos = sumaPatrimonio(activosNorm, a => a.tipo === 'LÍQUIDO' && !a.restringido);
    if(patrimonioBruto > 0 && totalDependientes > 0){
      const pctIliquido = 1 - (activosLiquidos / patrimonioBruto);
      const sumaSeguros = (L.segurosVida||[]).reduce((s,x)=>s+(x.sumaAsegurada||0),0);
      const cubierto = ingresoAnual > 0 && sumaSeguros >= ingresoAnual * 5;
      if(pctIliquido > LEGAL_UMBRALES.iliquidezCriticaPct && !cubierto){
        H({
          id:'R21_iliquidez_dependientes',
          sev:'media', categoria:'sucesion',
          titulo:'El '+Math.round(pctIliquido*100)+'% de tu patrimonio es difícil de vender rápido y tienes dependientes',
          descripcion:'Tienes '+formatearNumeroLista(totalDependientes)+' persona'+(totalDependientes>1?'s a cargo':' a cargo')+', pero solo '+fmt(activosLiquidos)+' están en cosas que se pueden convertir rápido en efectivo (cuentas, CDTs, portafolios de inversión). El resto está en cosas que toman meses o años en vender (casas, empresas, terrenos). Si te faltas hoy, tu familia queda con dos problemas: (1) sostenerse mientras se vende algún bien — pueden ser 6 meses a 2 años para un inmueble; (2) pagar el impuesto de herencia y las obligaciones que dejaste. <strong>Un seguro de vida resuelve las dos cosas</strong>: entrega efectivo en menos de un mes, y en Colombia hasta 3.250 UVT ('+fmt(3250*52374)+') no paga impuesto (art. 303-1 ET).',
          activosAfectados:[],
          norma:'Art. 303-1 del Estatuto Tributario (seguros de vida exentos hasta 3.250 UVT).',
          accionConcreta:'Como regla general, la suma asegurada se calcula así: <strong>ingresos anuales tuyos × 5 a 10 años</strong>, o el monto necesario para que tu familia pague el impuesto de herencia y viva bien 5 a 10 años sin ti. Contrata con <strong>beneficiarios específicos</strong> (nombres y cédulas), no con "beneficiarios de ley", para que el dinero llegue rápido y directo. Si los beneficiarios son menores, evalúa con la aseguradora dejar como beneficiario a un fideicomiso para que administre el dinero hasta que cumplan cierta edad.',
          profesionalRequerido:'asesor de seguros (varias aseguradoras cotizan gratis)',
          estimacionCosto:'Seguro de vida temporal (dura 20 años, luego termina): entre 0,3% y 1,5% del valor asegurado al año. Vitalicio (dura toda tu vida y acumula valor de rescate): 3 a 8 veces más caro pero es una inversión.'
        });
        P({
          id:'P_seguro_vida',
          titulo:'Contratar seguro de vida',
          descripcion:'Resuelve dos problemas al tiempo: liquidez inmediata para tu familia si tú faltas + sustento familiar mientras se resuelve la herencia. Costo controlado y el pago está exento de impuestos hasta $170 millones aproximadamente.',
          ctaLink:null
        });
      }
    }

    // R22 · Sin directiva médica anticipada
    const edadUsuario = (state.profile && state.profile.edad) || null;
    if(((edadUsuario && edadUsuario >= 55) || totalDependientes > 0) &&
       (!L.poderes || !L.poderes.directivaAnticipada)){
      H({
        id:'R22_sin_directiva',
        sev:'info', categoria:'sucesion',
        titulo:'No has dejado instrucciones médicas por escrito',
        descripcion:'La directiva médica anticipada (o "voluntad anticipada") es un documento donde escribes qué tratamientos médicos aceptas o rechazas si un día no puedes hablar por ti (por ejemplo, después de un accidente grave, coma, enfermedad muy avanzada). Sin este documento, esa decisión queda en manos de tus familiares — que pueden estar divididos, no saber qué querías, o entrar en conflicto entre ellos. Es especialmente importante si tienes personas que dependen de ti económicamente, porque evita procesos judiciales largos y costosos para autorizar decisiones sobre ti.',
        activosAfectados:[],
        norma:'Ley 1733 de 2014 · Resolución 1051 de 2016 del Ministerio de Salud.',
        accionConcreta:'Puedes hacerlo de dos formas: en <strong>notaría</strong> (la opción más común, queda protocolizado) o directamente con tu <strong>médico tratante</strong> (queda en tu historia clínica). Ahí puedes definir: qué tratamientos aceptas o rechazas si estás en fase terminal, si autorizas donación de órganos, y quién queda designado para tomar decisiones médicas por ti. Es un documento revocable — puedes cambiarlo cuando quieras. Combínalo con un <strong>poder general de administración</strong> para que la misma persona pueda manejar tus bienes durante una incapacidad temporal.',
        profesionalRequerido:'notario',
        estimacionCosto:'Directiva anticipada notarial: entre $150.000 y $300.000. Poder general adicional: entre $200.000 y $400.000.'
      });
    }

    // R23 · Actividad de riesgo profesional sin cobertura RC
    // Se dispara si tiene actividad de riesgo (CIIU) O es autoempleado en profesión liberal,
    // y NO tiene póliza de RC profesional, o la que tiene es baja.
    const cobRC = (L.coberturas && L.coberturas.rcProfesional) || {};
    const tieneRC = cobRC.tiene === true && (cobRC.sumaAsegurada || 0) > 0;
    if(riesgoProf && !tieneRC){
      const sev = cobRC.tiene === false ? 'alta' : 'media';   // 'null' = no respondió aún
      H({
        id:'R23_sin_rc_profesional',
        sev, categoria:'proteccion',
        titulo: cobRC.tiene === false ? 'No tienes póliza de responsabilidad civil profesional' : 'Verifica si tienes RC profesional',
        descripcion:'Trabajas en '+riesgoProf.desc+', un área donde los clientes pueden demandarte personalmente por errores profesionales — un procedimiento médico que salió mal, un edificio con fallas de construcción, una asesoría contable errada, un dictamen legal que resultó mal. La <strong>póliza de Responsabilidad Civil Profesional (RC)</strong> cubre esas demandas: paga la defensa jurídica y las condenas hasta el monto asegurado. Sin esta cobertura, cualquier condena la pagas con tus bienes personales. Importante: la SAS te protege de las deudas del negocio, pero <strong>NO</strong> de la responsabilidad profesional que te sigue a ti como persona.',
        activosAfectados:[],
        norma:'Código Civil arts. 2341 a 2360 (responsabilidad por daños) · Ley 1480 de 2011 (protección al consumidor).',
        accionConcreta:'Cotiza con al menos tres aseguradoras (Sura, Bolívar, Liberty, Chubb). Datos que te pedirán: profesión, años de experiencia, monto anual facturado, tipo de clientes, historial de reclamaciones. Como referencia, la suma asegurada suele calcularse como 3 a 5 años de facturación, con deducible ajustable. Muchos gremios profesionales (colegios de médicos, arquitectos, contadores) tienen convenios que dan tarifas preferenciales.',
        profesionalRequerido:'corredor o asesor de seguros',
        estimacionCosto:'Prima anual: entre 0,5% y 2% de tu facturación anual, dependiendo de la profesión y el historial. Ejemplo: un consultor que factura $200M/año paga entre $1 y $4 millones anuales.'
      });
    }

    // R24 · Directivo empresarial sin cobertura D&O
    // Se dispara si es representante legal / socio y RL / accionista con >20% en una empresa relevante,
    // y NO tiene póliza D&O.
    const rolesDirectivos = ['Propietario único','Representante legal','Socio y representante legal'];
    const negociosConRolDirectivo = activosDetalle.filter(a => {
      if(a.category !== 'Empresarial') return false;
      const nrm = normsById.get(a.id);
      const valCOP = nrm ? nrm.valor : 0;
      // Solo empresas relevantes: valor > 100 SMMLV
      if(valCOP <= smmlv * 100) return false;
      if(rolesDirectivos.includes(a.rolEmpresarial)) return true;
      // Accionista con participación relevante
      if((a.rolEmpresarial === 'Accionista' || a.rolEmpresarial === 'Socio') && (a.porcentajePropio || 0) > 20) return true;
      return false;
    });
    const cobDyo = (L.coberturas && L.coberturas.dyo) || {};
    const tieneDyo = cobDyo.tiene === true;
    if(negociosConRolDirectivo.length > 0 && !tieneDyo){
      const sev = cobDyo.tiene === false ? 'alta' : 'media';
      const listaEmpresas = negociosConRolDirectivo.map(a => {
        const nombre = a.description || a.subtype || 'Empresa sin nombre';
        return '<li><strong>'+nombre+'</strong> — rol: '+(a.rolEmpresarial || 'directivo')+'</li>';
      }).join('');
      H({
        id:'R24_sin_dyo',
        sev, categoria:'proteccion',
        titulo: cobDyo.tiene === false ? 'Sin póliza D&O y tienes rol directivo en empresas' : 'Verifica si tienes póliza D&O',
        descripcion:'Detectamos que tienes rol de administrador o directivo en:<ul class="leg-hall-list">'+listaEmpresas+'</ul>La póliza <strong>D&O (Directors & Officers, o de "administradores")</strong> protege tu patrimonio personal frente a demandas que puedas recibir por decisiones que tomes como administrador de la empresa. La ley colombiana es clara (Ley 222 de 1995, arts. 22 a 25): los administradores responden con su patrimonio personal por daños causados a la sociedad, socios o terceros cuando actúan con dolo o culpa grave. Ejemplos reales: una decisión que causó pérdidas grandes, no reportar información a socios, incumplir obligaciones fiscales. Sin D&O, esas demandas se pagan con tus bienes personales, y los honorarios de defensa jurídica los pones tú aunque al final ganes el caso.',
        activosAfectados: negociosConRolDirectivo.map(a=>a.id),
        norma:'Ley 222 de 1995 arts. 22 a 25 (deberes y responsabilidad de administradores) · Ley 1258 de 2008 arts. 27 y 43 (SAS · deber de diligencia y acción social de responsabilidad).',
        accionConcreta:'Hay dos formas de contratar D&O: (1) que la empresa la contrate cubriéndote a ti y a otros administradores (más común, y en algunas empresas es parte del paquete de compensación); (2) que tú la contrates personalmente si la empresa no lo hace. Cotiza con Chubb, Zurich, AIG, Liberty, HDI (aseguradoras especializadas en este ramo). Datos que necesitas: tipo de empresa (sector, ingresos anuales, cantidad de socios, si es cotizada), tu rol específico, historial de reclamaciones. Cobertura típica: entre $500M y $5.000M según el tamaño de la empresa.',
        profesionalRequerido:'corredor de seguros con experiencia en líneas financieras',
        estimacionCosto:'Prima anual: entre $3 y $30 millones para PyMEs y empresas medianas, dependiendo de sector, ingresos y cobertura. Si la empresa la contrata, es deducible como gasto.'
      });
    }


    const negociosSociales = activosDetalle.filter(a =>
      a.category === 'Empresarial' &&
      (a.legalStructure === 'Sociedad Comercial' || a.legalStructure === 'Holding')
    );
    const inmueblesProductivos = activosDetalle.filter(a =>
      a.category === 'Inmueble' && (a.monthlyIncome||0) > 0
    );
    const yaTieneHolding = activosNorm.filter(a => a._estructuraLegal === 'Holding').length > 0;
    if(negociosSociales.length >= 1 && inmueblesProductivos.length >= 1 &&
       patrimonioBruto > smmlv * 2000 && !yaTieneHolding){
      P({
        id:'P_holding',
        titulo:'Considera crear un holding',
        descripcion:'Tienes un negocio operativo, un inmueble que produce arriendos y un patrimonio de '+fmt(patrimonioBruto)+'. Un holding (una SAS cuyo único trabajo es ser dueña de otras empresas y bienes) tiene tres ventajas concretas: (1) los dividendos que te pasa tu SAS operativa al holding no pagan impuesto de renta otra vez (art. 246-1 ET); (2) heredar se vuelve más simple, tus hijos reciben "acciones del holding" en vez de una lista larga de bienes; (3) si tu SAS operativa tiene problemas, el holding y los bienes que hay dentro quedan protegidos. Requiere análisis previo con contador porque trasladar bienes tiene costo tributario.',
        estimacionCosto:'Constitución del holding y aporte de bienes: entre $5 y $20 millones según cuántos bienes se muevan. Mantenimiento anual: entre $5 y $10 millones.',
        ctaLink:null
      });
    }

    // R20 · Fideicomiso como palanca
    const yaTieneFideicomiso = activosFideicomiso.length > 0;
    if(patrimonioBruto > smmlv * 5000 &&
       (L.hijosMenores||0) > 0 &&
       hayEmpresarialAlto &&
       !yaTieneFideicomiso){
      P({
        id:'P_fideicomiso_sucesoral',
        titulo:'Considera un fideicomiso para administración sucesoral',
        descripcion:'Con un patrimonio de '+fmt(patrimonioBruto)+', hijos menores y una empresa familiar relevante, un fideicomiso te permite: (1) que una empresa profesional (Alianza, Fiduagraria, Skandia, entre otras) administre los bienes mientras tus hijos son menores; (2) definir por adelantado cuándo tus hijos reciben qué (por edades, hitos, o para usos específicos como estudios); (3) mantener la continuidad de la administración del negocio sin interrupciones si tú faltas. Es un vehículo estándar en Colombia para patrimonios de este tamaño.',
        estimacionCosto:'Constitución: entre $8 y $20 millones según el valor de los bienes que entregues. Comisión anual de la fiduciaria: entre 0,5% y 1,5% del valor administrado.',
        ctaLink:null
      });
    }


    /* ── CASO OK · Sin hallazgos ── */
    if(hallazgos.length === 0){
      H({
        id:'OK_sin_hallazgos',
        sev:'ok', categoria:'proteccion',
        titulo:'Sin hallazgos legales con la información que registraste',
        descripcion:'Con tus datos actuales, tu estructura patrimonial no dispara alertas de riesgo. Vale la pena revisar este módulo cada año o cuando cambien: tu estado civil, número de hijos/dependientes, adquisición de bienes importantes, o entrada/salida de sociedades.',
        activosAfectados:[]
      });
    }

    const resumen = {
      totalHallazgos: hallazgos.filter(h=>h.sev !== 'ok').length,
      porSeveridad: {
        alta: hallazgos.filter(h=>h.sev==='alta').length,
        media: hallazgos.filter(h=>h.sev==='media').length,
        info: hallazgos.filter(h=>h.sev==='info').length
      },
      totalPalancas: palancas.length
    };

    return { hallazgos, palancas, resumen };
  }


  /* ═════ RENDER DEL FORMULARIO ═════ */
  function renderEstructuraLegal(){
    inicializarLegal();   // siempre defensivo — garantiza estructura completa
    const L = state.fiscal.legal;

    if(!renderEstructuraLegal._wired){
      wireEstructuraLegal();
      renderEstructuraLegal._wired = true;
    }

    setSelLeg('leg-estado-civil', L.estadoCivil);
    setSelLeg('leg-regimen-conyugal', L.regimenConyugal);
    setValLeg('leg-anio-union', L.anioMatrimonioUnion);
    setValNumLeg('leg-hijos-menores', L.hijosMenores);
    setValNumLeg('leg-hijos-mayores', L.hijosMayoresDependientes);
    setValNumLeg('leg-otros-dep', L.otrosDependientes);
    const totalDep = (L.hijosMenores||0) + (L.hijosMayoresDependientes||0) + (L.otrosDependientes||0);
    toggleShowLeg('leg-gasto-familia-wrap', totalDep > 0);
    setMoneyValLeg('leg-gasto-familia', L.gastoMensualFamilia);
    toggleShowLeg('leg-regimen-wrap', L.estadoCivil === 'casado' || L.estadoCivil === 'union_marital');
    toggleShowLeg('leg-anio-union-wrap', L.estadoCivil === 'union_marital');

    setSelLeg('leg-testamento-tiene',
      L.testamento.tiene === true ? 'si' :
      L.testamento.tiene === false ? 'no' : '');
    toggleShowLeg('leg-testamento-detalle', L.testamento.tiene === true);
    setSelLeg('leg-testamento-tipo', L.testamento.tipo);
    setValLeg('leg-testamento-anio', L.testamento.anioOtorgamiento);
    setSelLeg('leg-testamento-revisado',
      L.testamento.revisadoTrasCambios === true ? 'si' :
      L.testamento.revisadoTrasCambios === false ? 'no' : '');
    setChkLeg('leg-poder-admin', L.poderes.generalAdmin);
    setChkLeg('leg-poder-directiva', L.poderes.directivaAnticipada);

    renderSegurosVida();

    const cob = L.coberturas || {};
    const inv = cob.invalidez || {};
    setSelLeg('leg-invalidez-tiene', inv.tiene === true ? 'si' : (inv.tiene === false ? 'no' : ''));
    toggleShowLeg('leg-invalidez-monto-wrap', inv.tiene === true);
    const invMi = document.getElementById('leg-invalidez-monto');
    if(invMi && (inv.rentaMensual||0) > 0) invMi.value = Number(inv.rentaMensual).toLocaleString('es-CO');
    setSelLeg('leg-vivienda-protegida', L.viviendaProtegida === true ? 'si' : (L.viviendaProtegida === false ? 'no' : ''));
    setSelLeg('leg-aval-sociedad', L.avalSociedad === true ? 'si' : (L.avalSociedad === false ? 'no' : ''));
    setSelLeg('leg-protocolo-familiar', L.protocoloFamiliar === true ? 'si' : (L.protocoloFamiliar === false ? 'no' : ''));
    setSelLeg('leg-guarda-designada', L.guardaDesignada === true ? 'si' : (L.guardaDesignada === false ? 'no' : ''));
    setSelLeg('leg-avales-tiene', L.avalesTerceros.tiene === true ? 'si' : (L.avalesTerceros.tiene === false ? 'no' : ''));
    toggleShowLeg('leg-avales-detalle', L.avalesTerceros.tiene === true);
    setMoneyValLeg('leg-avales-monto', L.avalesTerceros.monto);
    setValLeg('leg-avales-descripcion', L.avalesTerceros.detalle);
    setSelLeg('leg-pleitos-tiene', L.pleitosVigentes.tieneComoDemandado === true ? 'si' : (L.pleitosVigentes.tieneComoDemandado === false ? 'no' : ''));
    toggleShowLeg('leg-pleitos-detalle', L.pleitosVigentes.tieneComoDemandado === true);
    setMoneyValLeg('leg-pleitos-monto', L.pleitosVigentes.montoPretensiones);
    setValLeg('leg-pleitos-descripcion', L.pleitosVigentes.detalle);

    const tieneExterior = !!(state.fiscal.exterior && state.fiscal.exterior.tiene);
    toggleShowLeg('leg-exterior-wrap', tieneExterior);
    if(tieneExterior){
      setSelLeg('leg-form160-presentado',
        L.cumplimientoExterior.formulario160Presentado === true ? 'si' :
        L.cumplimientoExterior.formulario160Presentado === false ? 'no' : '');
      setChkLeg('leg-ece', L.cumplimientoExterior.tieneVehiculoECE);
    }

    // ─── Coberturas (RC profesional y D&O) — visibilidad según perfil ───
    renderBloqueColberturas();

    renderEstructuraDiagrama();
    renderDiagnosticoLegal();
  }


  /* ═════ VISIBILIDAD Y RENDER DEL BLOQUE 5 · COBERTURAS ═════ */
  // Decide qué preguntas mostrar según:
  //   - RC profesional: si el CIIU es de riesgo (misma tabla que R3)
  //   - D&O: si el usuario tiene rol directivo en al menos una empresa relevante
  function renderBloqueColberturas(){
    const L = state.fiscal.legal;
    // Preguntas del bloque 7 que solo aplican en ciertos casos
    try {
      const md = (typeof MapaPatrimonial !== 'undefined' && MapaPatrimonial.getData) ? MapaPatrimonial.getData() : {activos:[]};
      const tieneEmpresa = (md.activos||[]).some(a => a && a.category === 'Empresarial');
      toggleShowLeg('leg-empresa-wrap', tieneEmpresa);
      toggleShowLeg('leg-guarda-wrap', (+L.hijosMenores||0) > 0);
    } catch(e){}
    const mapa = (typeof MapaPatrimonial !== 'undefined' && MapaPatrimonial.getData)
      ? MapaPatrimonial.getData() : { activos:[], activosNormalizados:[] };

    // ¿Debe mostrarse la pregunta de RC?
    const riesgoProf = ciiuTieneRiesgoProfesional(state.fiscal.ciiu);
    const mostrarRC = !!riesgoProf;

    // ¿Debe mostrarse la pregunta de D&O?
    const rolesDirectivos = ['Propietario único','Representante legal','Socio y representante legal'];
    const smmlv = getSMMLV();
    const normsByIdLocal = new Map((mapa.activosNormalizados||[]).map(a => [a._mapaId, a]));
    const negociosConRolDirectivo = (mapa.activos||[]).filter(a => {
      if(a.category !== 'Empresarial') return false;
      const nrm = normsByIdLocal.get(a.id);
      const valCOP = nrm ? nrm.valor : 0;
      if(valCOP <= smmlv * 100) return false;
      if(rolesDirectivos.includes(a.rolEmpresarial)) return true;
      if((a.rolEmpresarial === 'Accionista' || a.rolEmpresarial === 'Socio') && (a.porcentajePropio || 0) > 20) return true;
      return false;
    });
    const mostrarDyo = negociosConRolDirectivo.length > 0;

    // Mostrar el bloque solo si al menos una aplica
    const mostrarBloque = mostrarRC || mostrarDyo;
    toggleShowLeg('leg-coberturas-wrap', mostrarBloque);
    toggleShowLeg('leg-rc-wrap', mostrarRC);
    toggleShowLeg('leg-dyo-wrap', mostrarDyo);

    if(!mostrarBloque) return;

    // Ajustar el subtítulo según qué aplica
    const sub = document.getElementById('leg-coberturas-sub');
    if(sub){
      const razones = [];
      if(mostrarRC) razones.push('tu actividad ('+riesgoProf.desc+')');
      if(mostrarDyo) razones.push('tu rol de administrador en '+negociosConRolDirectivo.length+' empresa'+(negociosConRolDirectivo.length>1?'s':''));
      sub.textContent = 'Con ' + razones.join(' y ') + ', tu patrimonio personal puede quedar expuesto sin las coberturas adecuadas';
    }

    // Poblar valores actuales
    if(mostrarRC){
      const rc = L.coberturas.rcProfesional;
      setSelLeg('leg-rc-tiene',
        rc.tiene === true ? 'si' :
        rc.tiene === false ? 'no' :
        rc.tiene === 'no_se' ? 'no_se' : '');
      toggleShowLeg('leg-rc-monto-wrap', rc.tiene === true);
      setMoneyValLeg('leg-rc-monto', rc.sumaAsegurada);
    }
    if(mostrarDyo){
      const dyo = L.coberturas.dyo;
      setSelLeg('leg-dyo-tiene',
        dyo.tiene === true ? 'si' :
        dyo.tiene === false ? 'no' :
        dyo.tiene === 'no_se' ? 'no_se' : '');
      toggleShowLeg('leg-dyo-quien-wrap', dyo.tiene === true);
      setSelLeg('leg-dyo-quien', dyo.quienContrata);
    }
  }

  function inicializarLegal(){
    if(!state.fiscal.legal) state.fiscal.legal = {};
    const L = state.fiscal.legal;
    // Defaults defensivos: garantizan que TODOS los sub-objetos existan, sin sobrescribir valores del usuario.
    if(L.estadoCivil == null) L.estadoCivil = '';
    if(L.regimenConyugal == null) L.regimenConyugal = '';
    if(L.anioMatrimonioUnion == null) L.anioMatrimonioUnion = '';
    if(L.hijosMenores == null) L.hijosMenores = 0;
    if(L.hijosMayoresDependientes == null) L.hijosMayoresDependientes = 0;
    if(L.otrosDependientes == null) L.otrosDependientes = 0;
    if(L.gastoMensualFamilia == null) L.gastoMensualFamilia = 0;
    if(!L.testamento || typeof L.testamento !== 'object') L.testamento = {};
    if(L.testamento.tiene === undefined) L.testamento.tiene = null;
    if(L.testamento.tipo == null) L.testamento.tipo = '';
    if(L.testamento.anioOtorgamiento == null) L.testamento.anioOtorgamiento = '';
    if(L.testamento.revisadoTrasCambios === undefined) L.testamento.revisadoTrasCambios = null;
    if(!L.poderes || typeof L.poderes !== 'object') L.poderes = {};
    if(L.poderes.generalAdmin == null) L.poderes.generalAdmin = false;
    if(L.poderes.directivaAnticipada == null) L.poderes.directivaAnticipada = false;
    if(!Array.isArray(L.segurosVida)) L.segurosVida = [];
    if(!L.avalesTerceros || typeof L.avalesTerceros !== 'object') L.avalesTerceros = {};
    if(L.avalesTerceros.tiene === undefined) L.avalesTerceros.tiene = null;
    if(L.avalesTerceros.monto == null) L.avalesTerceros.monto = 0;
    if(L.avalesTerceros.detalle == null) L.avalesTerceros.detalle = '';
    if(!L.pleitosVigentes || typeof L.pleitosVigentes !== 'object') L.pleitosVigentes = {};
    if(L.pleitosVigentes.tieneComoDemandado === undefined) L.pleitosVigentes.tieneComoDemandado = null;
    if(L.pleitosVigentes.montoPretensiones == null) L.pleitosVigentes.montoPretensiones = 0;
    if(L.pleitosVigentes.detalle == null) L.pleitosVigentes.detalle = '';
    if(!L.cumplimientoExterior || typeof L.cumplimientoExterior !== 'object') L.cumplimientoExterior = {};
    if(L.cumplimientoExterior.formulario160Presentado === undefined) L.cumplimientoExterior.formulario160Presentado = null;
    if(L.cumplimientoExterior.tieneVehiculoECE == null) L.cumplimientoExterior.tieneVehiculoECE = false;
    if(L.cumplimientoExterior.detalleECE == null) L.cumplimientoExterior.detalleECE = '';
    if(!L.coberturas || typeof L.coberturas !== 'object') L.coberturas = {};
    if(!L.coberturas.rcProfesional || typeof L.coberturas.rcProfesional !== 'object') L.coberturas.rcProfesional = {};
    if(L.coberturas.rcProfesional.tiene === undefined) L.coberturas.rcProfesional.tiene = null;
    if(L.coberturas.rcProfesional.sumaAsegurada == null) L.coberturas.rcProfesional.sumaAsegurada = 0;
    if(!L.coberturas.dyo || typeof L.coberturas.dyo !== 'object') L.coberturas.dyo = {};
    if(L.coberturas.dyo.tiene === undefined) L.coberturas.dyo.tiene = null;
    if(L.coberturas.dyo.quienContrata == null) L.coberturas.dyo.quienContrata = '';
    if(!L.planSucesoral || typeof L.planSucesoral !== 'object') L.planSucesoral = {};
    if(!L.planSucesoral.acciones || typeof L.planSucesoral.acciones !== 'object') L.planSucesoral.acciones = {};
  }

  function setSelLeg(id, v){ const el=document.getElementById(id); if(el) el.value = v==null?'':v; }
  function setValLeg(id, v){ const el=document.getElementById(id); if(el) el.value = v==null?'':v; }
  function setValNumLeg(id, v){ const el=document.getElementById(id); if(el) el.value = (v>0)?v:''; }
  function setChkLeg(id, v){ const el=document.getElementById(id); if(el){ el.classList.toggle('on', !!v); } }
  function setMoneyValLeg(id, v){ const el=document.getElementById(id); if(el) el.value = v>0?fmtInput(v):''; }
  function toggleShowLeg(id, v){ const el=document.getElementById(id); if(el) el.style.display = v ? '' : 'none'; }


  /* ═════ SEGUROS DE VIDA (lista repetible) ═════ */
  function renderSegurosVida(){
    const cont = document.getElementById('leg-seguros-list'); if(!cont) return;
    const L = state.fiscal.legal;
    if(!L.segurosVida) L.segurosVida = [];

    cont.innerHTML = L.segurosVida.map((s, idx) => `
      <div class="leg-seguro-row" data-idx="${idx}">
        <div class="pf-grid2">
          <div class="pf-field">
            <label>Aseguradora</label>
            <div class="pf-inp"><input type="text" data-fld="aseguradora" value="${(s.aseguradora||'').replace(/"/g,'&quot;')}" placeholder="Sura, Bolívar, Allianz…"></div>
          </div>
          <div class="pf-field">
            <label>Suma asegurada</label>
            <div class="pf-inp pf-mono"><span class="pf-pre">$</span><input type="text" data-fld="sumaAsegurada" inputmode="numeric" value="${s.sumaAsegurada>0?fmtInput(s.sumaAsegurada):''}" placeholder="0"></div>
          </div>
        </div>
        <div class="pf-field" style="margin-top:10px">
          <label>¿A quién le paga la aseguradora si tú faltas? <span class="info-tip" data-def="leg_beneficiarios" tabindex="0">i</span></label>
          <select class="pf-select" data-fld="beneficiarios">
            <option value="">Selecciona</option>
            <option value="legales" ${s.beneficiarios==='legales'?'selected':''}>A los beneficiarios "de ley" (los que determine la sucesión)</option>
            <option value="especificos" ${s.beneficiarios==='especificos'?'selected':''}>A personas específicas que yo designé</option>
            <option value="no_se" ${s.beneficiarios==='no_se'?'selected':''}>No estoy seguro</option>
          </select>
        </div>
        <button class="leg-seguro-del" data-idx="${idx}" type="button">Eliminar</button>
      </div>
    `).join('');

    cont.querySelectorAll('.leg-seguro-row').forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      row.querySelectorAll('input[data-fld], select[data-fld]').forEach(inp => {
        inp.addEventListener('input', function(){
          const fld = this.dataset.fld;
          if(fld === 'sumaAsegurada'){
            L.segurosVida[idx][fld] = n(this.value);
          } else {
            L.segurosVida[idx][fld] = this.value;
          }
          scheduleSave('fiscal'); renderDiagnosticoLegal();
        });
        if(inp.dataset.fld === 'sumaAsegurada'){ attachMoneyInput(inp); }
      });
      row.querySelector('.leg-seguro-del').addEventListener('click', function(){
        L.segurosVida.splice(idx, 1);
        scheduleSave('fiscal'); renderSegurosVida(); renderDiagnosticoLegal();
      });
    });
  }


  /* ═════ RENDER DEL DIAGNÓSTICO ═════ */
  // ── Diagrama de estructura legal · árbol calculado sin solapamientos ────
  // Genera el diagrama de estructura legal como SVG con estilos EN LÍNEA (para el PDF,
  // que no aplica clases CSS). Agrupa por tipo bajo cada figura legal / "A tu nombre".
  function buildEstructuraDiagramaSVG(acts){
    acts = acts || [];
    if(!acts.length) return null;
    const cabeza = (state.profile && state.profile.nombre) ? state.profile.nombre : 'Tú';
    const VEH = {
      'Sociedad Comercial':{label:'Sociedad comercial',sub:'SAS · Ltda · S.A.',c:'#2563eb',bg:'#eff4ff'},
      'LLC':{label:'LLC',sub:'Sociedad en el exterior',c:'#0e7c4a',bg:'#eaf6ef'},
      'Holding':{label:'Holding familiar',sub:'Agrupa tus bienes',c:'#7c3aed',bg:'#f3edff'},
      'Fideicomiso':{label:'Fideicomiso / trust',sub:'Patrimonio autónomo',c:'#b45309',bg:'#fbf1e6'},
      'Otro':{label:'Otra figura',sub:'Por confirmar',c:'#6f6e6a',bg:'#f5f5f3'}
    };
    const TIPO = {
      'Financiero':{label:'Financiero',c:'#0e7c4a',bg:'#f0f8f3'},'Inmueble':{label:'Inmuebles',c:'#b45309',bg:'#fdf7ef'},
      'Empresarial':{label:'Empresarial',c:'#2563eb',bg:'#f3f7ff'},'Uso Personal':{label:'Uso personal',c:'#6f6e6a',bg:'#f7f6f3'},
      'Alternativo':{label:'Alternativos',c:'#7c3aed',bg:'#f6f2fd'}
    };
    const tipoDe = a => TIPO[a._categoria] ? a._categoria : 'Otro';
    const fmtM = v => fmt(v||0);
    const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Agrupar
    const directo={}, vehic={};
    let dTot=0;
    acts.forEach(a=>{
      const est=a._estructuraLegal, t=tipoDe(a);
      if(!est || est==='Propiedad Directa'){ directo[t]=directo[t]||{n:0,tot:0}; directo[t].n++; directo[t].tot+=a.valor||0; dTot+=a.valor||0; }
      else { const v=vehic[est]=vehic[est]||{g:{}}; v.g[t]=v.g[t]||{n:0,tot:0}; v.g[t].n++; v.g[t].tot+=a.valor||0; }
    });
    const ramas=[];
    Object.keys(vehic).forEach(est=>{ const i=VEH[est]||VEH['Otro']; ramas.push({label:i.label,sub:i.sub,c:i.c,bg:i.bg,g:vehic[est].g}); });
    const hayVeh = ramas.length>0;
    const hayDir = Object.keys(directo).length>0;
    if(hayDir && hayVeh) ramas.unshift({label:'A tu nombre',sub:'Sin sociedad de por medio',c:'#2b2b2e',bg:'#ffffff',g:directo});

    const anchoTexto=(t,mono)=>(t?String(t).length:0)*(mono?4.9:5.9);
    const anchoCaja=(tit,sub,mono,min)=>Math.max(Math.max(anchoTexto(tit,false),anchoTexto(sub,mono))+28, min||120);
    const CAB_H=44, GRP_H=38, PAD=10;
    const box=(x,y,w,h,tit,sub,fill,stroke,txtColor,mono)=>{
      let s='<rect x="'+(x-w/2)+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="8" fill="'+fill+'" stroke="'+stroke+'" stroke-width="1.5"/>';
      s+='<text x="'+x+'" y="'+(y+(sub?16:h/2+4))+'" text-anchor="middle" font-size="10.5" font-weight="bold" fill="'+txtColor+'" font-family="Helvetica">'+esc(tit)+'</text>';
      if(sub) s+='<text x="'+x+'" y="'+(y+29)+'" text-anchor="middle" font-size="'+(mono?8:8.5)+'" fill="'+(txtColor==='#ffffff'?'#cfcfcf':'#6f6e6a')+'" font-family="'+(mono?'Courier':'Helvetica')+'">'+esc(sub)+'</text>';
      return s;
    };
    const linea=(x1,y1,x2,y2)=>{const my=(y1+y2)/2;return '<path d="M'+x1+' '+y1+' L'+x1+' '+my+' L'+x2+' '+my+' L'+x2+' '+y2+'" fill="none" stroke="#d9d6cf" stroke-width="1.2"/>';};
    const grpSub=g=>g.n+(g.n===1?' activo · ':' activos · ')+fmtM(g.tot);
    const CAB_W=anchoCaja(cabeza,'Tú, la persona',false,180);

    let svg, W, H;
    if(!hayVeh){
      const grupos=Object.keys(directo).sort((a,b)=>directo[b].tot-directo[a].tot);
      const n=grupos.length, GAP=16;
      const anchos=grupos.map(t=>anchoCaja((TIPO[t]||{label:'Otros'}).label, grpSub(directo[t]), true, 128));
      const suma=anchos.reduce((s,w)=>s+w,0);
      W=Math.max(suma+(n-1)*GAP+PAD*2, CAB_W+PAD*2);
      const yCab=PAD, yGrp=yCab+CAB_H+40; H=yGrp+GRP_H+PAD; const cx=W/2;
      let sx=(W-(suma+(n-1)*GAP))/2; const cen=anchos.map((w,i)=>{const c=sx+w/2;sx+=w+GAP;return c;});
      svg='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg">';
      grupos.forEach((t,i)=>svg+=linea(cx,yCab+CAB_H,cen[i],yGrp));
      svg+=box(cx,yCab,CAB_W,CAB_H,cabeza,'Tú, la persona','#1a1a1a','#1a1a1a','#ffffff',false);
      grupos.forEach((t,i)=>{const T=TIPO[t]||{label:'Otros',c:'#6f6e6a',bg:'#f5f5f3'};svg+=box(cen[i],yGrp,anchos[i],GRP_H,T.label,grpSub(directo[t]),T.bg,T.c,'#16201c',true);});
      svg+='</svg>';
    } else {
      const nR=ramas.length, GAP=20, GG=8;
      const rAnchos=ramas.map(r=>{let w=anchoCaja(r.label,r.sub,false,148);Object.keys(r.g).forEach(t=>{w=Math.max(w,anchoCaja((TIPO[t]||{label:'Otros'}).label,grpSub(r.g[t]),true,128));});return w;});
      const suma=rAnchos.reduce((s,w)=>s+w,0);
      W=Math.max(suma+(nR-1)*GAP+PAD*2, CAB_W+PAD*2);
      const yCab=PAD, yR=yCab+CAB_H+38, yG0=yR+CAB_H+16;
      const maxG=Math.max(1,...ramas.map(r=>Object.keys(r.g).length));
      H=yG0+maxG*(GRP_H+GG)+PAD; const cx=W/2;
      let sx=(W-(suma+(nR-1)*GAP))/2; const rc=rAnchos.map((w,i)=>{const c=sx+w/2;sx+=w+GAP;return c;});
      svg='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg">';
      ramas.forEach((r,i)=>svg+=linea(cx,yCab+CAB_H,rc[i],yR));
      svg+=box(cx,yCab,CAB_W,CAB_H,cabeza,'Tú, la persona','#1a1a1a','#1a1a1a','#ffffff',false);
      ramas.forEach((r,i)=>{
        const x=rc[i], rw=rAnchos[i];
        svg+=box(x,yR,rw,CAB_H,r.label,r.sub,r.bg,r.c,'#16201c',false);
        const tipos=Object.keys(r.g).sort((a,b)=>r.g[b].tot-r.g[a].tot);
        tipos.forEach((t,gi)=>{const gy=yG0+gi*(GRP_H+GG);const T=TIPO[t]||{label:'Otros',c:'#6f6e6a',bg:'#f5f5f3'};
          if(gi===0) svg+=linea(x,yR+CAB_H,x,gy); else svg+='<path d="M'+x+' '+(gy-GG)+' L'+x+' '+gy+'" fill="none" stroke="#d9d6cf" stroke-width="1.2"/>';
          svg+=box(x,gy,rw,GRP_H,T.label,grpSub(r.g[t]),T.bg,T.c,'#16201c',true);});
      });
      svg+='</svg>';
    }
    return { svg, width:W, height:H };
  }

  function renderEstructuraDiagrama(){
    const cont = document.getElementById('leg-estructura-diagrama');
    if(!cont) return;
    const md = (typeof MapaPatrimonial !== 'undefined' && MapaPatrimonial.getData) ? MapaPatrimonial.getData() : null;
    const acts = (md && md.activosNormalizados) ? md.activosNormalizados : [];
    if(!acts.length){ cont.innerHTML=''; return; }

    const cabeza = (state.profile && state.profile.nombre) ? state.profile.nombre : 'Tú';
    const VEHIC = {
      'Sociedad Comercial': { label:'Sociedad comercial', sub:'SAS · Ltda · S.A.', clase:'soc' },
      'LLC':                { label:'LLC', sub:'Sociedad en el exterior', clase:'llc' },
      'Holding':            { label:'Holding familiar', sub:'Agrupa tus bienes', clase:'hold' },
      'Fideicomiso':        { label:'Fideicomiso / trust', sub:'Patrimonio autónomo', clase:'fid' },
      'Otro':               { label:'Otra figura', sub:'Por confirmar', clase:'otro' },
    };
    // Tipo de activo → etiqueta y clase de color (para las cajas agrupadas)
    const TIPO = {
      'Financiero':  { label:'Financiero',   clase:'fin' },
      'Inmueble':    { label:'Inmuebles',    clase:'inm' },
      'Empresarial': { label:'Empresarial',  clase:'emp' },
      'Uso Personal':{ label:'Uso personal', clase:'uso' },
      'Alternativo': { label:'Alternativos', clase:'otr' },
    };
    const tipoDe = (a) => TIPO[a._categoria] ? a._categoria : 'Otro';

    // 1) Repartir activos: los de figura legal en su rama; lo demás bajo "A tu nombre".
    const ramas = [];  // {tipo:'directo'|'vehiculo', est, label, sub, clase, grupos:{tipo:{n,total}}, total}
    const directoGrupos = {}; let directoTotal = 0;
    const vehiculosMap = {};
    acts.forEach(a=>{
      const est = a._estructuraLegal;
      const t = tipoDe(a);
      if(!est || est === 'Propiedad Directa'){
        directoGrupos[t] = directoGrupos[t] || {n:0,total:0};
        directoGrupos[t].n++; directoGrupos[t].total += (a.valor||0); directoTotal += (a.valor||0);
      } else {
        const v = vehiculosMap[est] = vehiculosMap[est] || {grupos:{}, total:0};
        v.grupos[t] = v.grupos[t] || {n:0,total:0};
        v.grupos[t].n++; v.grupos[t].total += (a.valor||0); v.total += (a.valor||0);
      }
    });
    Object.keys(vehiculosMap).forEach(est=>{
      const info = VEHIC[est] || VEHIC['Otro'];
      ramas.push({ tipo:'vehiculo', label:info.label, sub:info.sub, clase:'veh '+info.clase, grupos:vehiculosMap[est].grupos, total:vehiculosMap[est].total });
    });
    const hayDirectos = Object.keys(directoGrupos).length > 0;
    const hayVehiculos = ramas.length > 0;   // ramas hasta aquí solo contiene figuras legales
    // "A tu nombre" solo tiene sentido como rama cuando HAY figuras de las que distinguirlo.
    if(hayDirectos && hayVehiculos) ramas.unshift({ tipo:'directo', label:'A tu nombre', sub:'Sin sociedad de por medio', clase:'veh dir', grupos:directoGrupos, total:directoTotal });

    // 2) Layout compacto con cajas que SE AJUSTAN A SU TEXTO (nunca se desbordan).
    const CAB_H = 44, GRP_H = 38, PAD = 10;
    // Ancho aproximado del texto según fuente. mono ≈ 5.4px/char a 9px; sans ≈ 6.6px/char a 12px.
    const anchoTexto = (t, mono) => (t ? t.length : 0) * (mono ? 4.9 : 5.9);
    const anchoCaja = (titulo, sub, subMono, min) => {
      const w = Math.max(anchoTexto(titulo,false), anchoTexto(sub,subMono)) + 28;  // +padding lateral
      return Math.max(w, min||120);
    };
    const rectBox = (x, y, w, h, titulo, sub, clase, mono) =>
      '<g class="leg-node '+clase+'">'
      + '<rect x="'+(x-w/2)+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="9"/>'
      + '<text class="leg-node-t" x="'+x+'" y="'+(y+(sub?16:h/2+4))+'">'+escapeHtml(titulo)+'</text>'
      + (sub ? '<text class="leg-node-s'+(mono?' mono':'')+'" x="'+x+'" y="'+(y+28)+'">'+escapeHtml(sub)+'</text>' : '')
      + '</g>';
    const linea = (x1,y1,x2,y2) => { const my=(y1+y2)/2; return '<path class="leg-link" d="M'+x1+' '+y1+' L'+x1+' '+my+' L'+x2+' '+my+' L'+x2+' '+y2+'"/>'; };
    const grupoSub = (g) => g.n + (g.n===1?' activo · ':' activos · ') + fmt(g.total);
    const CAB_W = anchoCaja(cabeza, 'Tú, la persona', false, 190);

    let svg, totalW, totalH;
    if(!hayVehiculos){
      const grupos = Object.keys(directoGrupos).sort((a,b)=> directoGrupos[b].total - directoGrupos[a].total);
      const n = grupos.length, GAP_X = 18;
      // ancho de cada caja según su propio contenido
      const anchos = grupos.map(t => { const info=TIPO[t]||{label:'Otros'}; return anchoCaja(info.label, grupoSub(directoGrupos[t]), true, 130); });
      const sumaAnchos = anchos.reduce((s,w)=>s+w,0);
      totalW = Math.max(sumaAnchos + (n-1)*GAP_X + PAD*2, CAB_W + PAD*2);
      const yCab = PAD, yGrp = yCab + CAB_H + 46;
      totalH = yGrp + GRP_H + PAD;
      const cx = totalW/2;
      // posiciones centradas
      let startX = (totalW - (sumaAnchos + (n-1)*GAP_X))/2;
      const centros = anchos.map((w,i)=>{ const c = startX + w/2; startX += w + GAP_X; return c; });
      svg = '<svg viewBox="0 0 '+totalW+' '+totalH+'" preserveAspectRatio="xMidYMin meet" class="leg-svg">';
      grupos.forEach((t,i)=> svg += linea(cx, yCab+CAB_H, centros[i], yGrp));
      svg += rectBox(cx, yCab, CAB_W, CAB_H, cabeza, 'Tú, la persona', 'cab');
      grupos.forEach((t,i)=>{ const info=TIPO[t]||{label:'Otros',clase:'otr'}; svg += rectBox(centros[i], yGrp, anchos[i], GRP_H, info.label, grupoSub(directoGrupos[t]), 'grp '+info.clase, true); });
      svg += '</svg>';
    } else {
      const nR = ramas.length, GAP_X = 22, GRP_GAP = 8;
      // ancho de cada rama = el máximo entre su etiqueta y sus grupos
      const ramaAnchos = ramas.map(r=>{
        let w = anchoCaja(r.label, r.sub, false, 150);
        Object.keys(r.grupos).forEach(t=>{ const info=TIPO[t]||{label:'Otros'}; w = Math.max(w, anchoCaja(info.label, grupoSub(r.grupos[t]), true, 130)); });
        return w;
      });
      const sumaR = ramaAnchos.reduce((s,w)=>s+w,0);
      totalW = Math.max(sumaR + (nR-1)*GAP_X + PAD*2, CAB_W + PAD*2);
      const yCab = PAD, yRama = yCab + CAB_H + 44, yGrp0 = yRama + CAB_H + 18;
      const maxG = Math.max(1, ...ramas.map(r=>Object.keys(r.grupos).length));
      totalH = yGrp0 + maxG*(GRP_H+GRP_GAP) + PAD;
      const cx = totalW/2;
      let startX = (totalW - (sumaR + (nR-1)*GAP_X))/2;
      const rCentros = ramaAnchos.map((w,i)=>{ const c = startX + w/2; startX += w + GAP_X; return c; });
      svg = '<svg viewBox="0 0 '+totalW+' '+totalH+'" preserveAspectRatio="xMidYMin meet" class="leg-svg">';
      ramas.forEach((r,i)=> svg += linea(cx, yCab+CAB_H, rCentros[i], yRama));
      svg += rectBox(cx, yCab, CAB_W, CAB_H, cabeza, 'Tú, la persona', 'cab');
      ramas.forEach((r,i)=>{
        const x = rCentros[i], rw = ramaAnchos[i];
        svg += rectBox(x, yRama, rw, CAB_H, r.label, r.sub, r.clase);
        const tipos = Object.keys(r.grupos).sort((a,b)=> r.grupos[b].total - r.grupos[a].total);
        tipos.forEach((t,gi)=>{
          const gy = yGrp0 + gi*(GRP_H+GRP_GAP); const info=TIPO[t]||{label:'Otros',clase:'otr'};
          if(gi===0) svg += linea(x, yRama+CAB_H, x, gy);
          else svg += '<path class="leg-link" d="M'+x+' '+(gy-GRP_GAP)+' L'+x+' '+gy+'"/>';
          svg += rectBox(x, gy, rw, GRP_H, info.label, grupoSub(r.grupos[t]), 'grp '+info.clase, true);
        });
      });
      svg += '</svg>';
    }

    cont.innerHTML =
      '<div class="card leg-diag-card"><div class="card-head">'
      + '<div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M12 12H5v4M12 12h7v4"/></svg></div>'
      + '<h3>Cómo está organizado tu patrimonio</h3></div>'
      + '<p class="summary-note" style="margin-top:0">Así se ve hoy quién es dueño de qué, agrupado por tipo de bien. '
      + (hayVehiculos ? 'Lo que cuelga de una sociedad o figura está un paso separado de ti; lo que está “a tu nombre” responde directamente contigo.' : 'Todo está directamente a tu nombre: no hay ninguna sociedad o figura que separe tus bienes de ti, así que todos responden ante una demanda o un embargo.')
      + ' Los nombres de cada bien están en tu Mapa Patrimonial.</p>'
      + '<div class="leg-diag-scroll">'+svg+'</div>'
      + '<p class="pf-note" style="margin-top:12px">Esquema educativo según lo que registraste en tu Mapa Patrimonial. No reemplaza el consejo de un abogado.</p>'
      + '</div>';
  }

  function renderDiagnosticoLegal(){
    const cont = document.getElementById('leg-diagnostico'); if(!cont) return;
    inicializarLegal();   // defensivo
    const L = state.fiscal.legal;
    const test = L.testamento || {};
    const aval = L.avalesTerceros || {};
    const pleit = L.pleitosVigentes || {};

    const llenoAlgo =
      !!L.estadoCivil ||
      (test.tiene !== null && test.tiene !== undefined) ||
      (aval.tiene !== null && aval.tiene !== undefined) ||
      (pleit.tieneComoDemandado !== null && pleit.tieneComoDemandado !== undefined) ||
      (Array.isArray(L.segurosVida) && L.segurosVida.length > 0);

    if(!llenoAlgo){
      cont.innerHTML = `
        <div class="pf-note" style="text-align:center;padding:30px 20px">
          Completa los datos de arriba para ver tu diagnóstico legal patrimonial.
        </div>`;
      return;
    }

    const { hallazgos, palancas, resumen } = evaluarEstructuraLegal();

    const ordenSev = { alta:0, media:1, info:2, ok:3 };
    hallazgos.sort((a,b) => (ordenSev[a.sev]||9) - (ordenSev[b.sev]||9));

    let html = '';

    html += '<div class="pf-diag-head">';
    html += '<h3>Diagnóstico legal patrimonial</h3>';
    if(resumen.totalHallazgos === 0){
      html += '<p>Sin hallazgos relevantes con los datos registrados. Revísalo cada año.</p>';
    } else {
      html += '<p>Detectamos '+resumen.totalHallazgos+' punto'+(resumen.totalHallazgos>1?'s':'')+' que conviene revisar';
      if(resumen.porSeveridad.alta > 0) html += ', de los cuales '+resumen.porSeveridad.alta+' es'+(resumen.porSeveridad.alta>1?'':'')+' de alta prioridad';
      html += '. Cada uno incluye la acción concreta y el profesional que la ejecuta cuando aplica.</p>';
    }
    html += '</div>';

    html += '<div class="leg-disclaimer">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      + '<span>Este diagnóstico es informativo, con normativa colombiana vigente y tus datos declarados. No sustituye asesoría legal para actos concretos: testamentos y capitulaciones se hacen ante notaría, la constitución de sociedades requiere abogado o cámara de comercio, y los procesos judiciales requieren apoderado. Las estimaciones de costo son órdenes de magnitud referenciales.</span>'
      + '</div>';

    hallazgos.forEach(h => {
      const icoSev = h.sev === 'alta' ? '!' : (h.sev === 'media' ? '!' : (h.sev === 'ok' ? '✓' : 'i'));
      html += '<div class="leg-hall sev-'+h.sev+'" id="hall-'+h.id+'">';
      html += '  <div class="leg-hall-head">';
      html += '    <span class="leg-hall-ico">'+icoSev+'</span>';
      html += '    <div class="leg-hall-titles">';
      html += '      <div class="leg-hall-cat">'+categoriaLabelLeg(h.categoria)+'</div>';
      html += '      <div class="leg-hall-t">'+h.titulo+'</div>';
      html += '    </div>';
      html += '  </div>';
      html += '  <div class="leg-hall-body">';
      html += '    <p class="leg-hall-desc">'+h.descripcion+'</p>';
      if(h.accionConcreta){
        html += '    <div class="leg-hall-block"><div class="leg-hall-label">Qué hacer</div><div>'+h.accionConcreta+'</div></div>';
      }
      if(h.profesionalRequerido || h.estimacionCosto){
        html += '    <div class="leg-hall-meta">';
        if(h.profesionalRequerido){
          html += '<span class="leg-hall-tag">Profesional: '+h.profesionalRequerido+'</span>';
        }
        if(h.estimacionCosto){
          html += '<span class="leg-hall-tag">Costo referencial: '+h.estimacionCosto+'</span>';
        }
        html += '    </div>';
      }
      if(h.norma){
        html += '    <div class="leg-hall-norma"><strong>Norma:</strong> '+h.norma+'</div>';
      }
      if(h.activosAfectados && h.activosAfectados.length > 0){
        html += '    <div class="leg-hall-links">Aplica a: ';
        html += h.activosAfectados.map(id => '<a href="#" data-goto-asset="'+id+'">Ver activo</a>').join(' · ');
        html += '</div>';
      }
      if(h.cta && h.ctaLink){
        html += '    <button class="pf-cta-mini" data-goto-mod="'+h.ctaLink+'">'+h.cta+'</button>';
      }
      html += '  </div>';
      html += '</div>';
    });

    if(palancas.length > 0){
      html += '<div class="leg-palancas">';
      html += '  <h4>Palancas recomendadas</h4>';
      html += '  <p class="pf-note" style="margin-top:0">Acciones proactivas que puedes activar en los próximos 12 meses. Cada una se implementa una vez y produce beneficios año tras año.</p>';
      palancas.forEach(p => {
        html += '  <div class="leg-palanca">';
        html += '    <div class="leg-palanca-t">'+p.titulo+'</div>';
        html += '    <div class="leg-palanca-d">'+p.descripcion+'</div>';
        if(p.estimacionCosto){
          html += '    <div class="leg-hall-tag">Costo referencial: '+p.estimacionCosto+'</div>';
        }
        html += '  </div>';
      });
      html += '</div>';
    }

    cont.innerHTML = html;

    // Mostrar/ocultar el botón "Planifica tu sucesión" según si hay algo material que planificar
    // (se muestra si hay dependientes o patrimonio > 200 SMMLV)
    const totalDepM13 = (L.hijosMenores||0) + (L.hijosMayoresDependientes||0) + (L.otrosDependientes||0);
    const mapaCheck = (typeof MapaPatrimonial !== 'undefined' && MapaPatrimonial.getData)
      ? MapaPatrimonial.getData() : { resumen:{patrimonioBrutoCOP:0} };
    const patBruto = (mapaCheck.resumen && mapaCheck.resumen.patrimonioBrutoCOP) || 0;
    const mostrarBtnM14 = totalDepM13 > 0 || patBruto > getSMMLV() * 200;
    const btnM14 = document.getElementById('leg-goto-m14');
    if(btnM14) btnM14.style.display = mostrarBtnM14 ? '' : 'none';

    cont.querySelectorAll('[data-goto-asset]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        try{ navigateTo(3); }catch(err){}
      });
    });
    cont.querySelectorAll('[data-goto-mod]').forEach(b => {
      b.addEventListener('click', () => {
        const m = parseInt(b.dataset.gotoMod, 10);
        try{ navigateTo(m); }catch(err){}
      });
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════════
     MÓDULO 14 · RENDER
     Renderiza toda la sección de planificación sucesoral en su propio módulo.
     Reutiliza las funciones renderPlanQuePasaria, renderPlanFlujoCaja,
     renderPlanAcciones, renderPlanCTAs que viven en el bloque de planificación.
     ═══════════════════════════════════════════════════════════════════════════ */
  function renderModulo14(){
    const cont = document.getElementById('m14-content'); if(!cont) return;
    inicializarLegal();

    // Necesitamos correr el motor de diagnóstico para tener los hallazgos que alimentan el plan.
    let hallazgos = [];
    try {
      const res = evaluarEstructuraLegal();
      hallazgos = res.hallazgos || [];
    } catch(err) {
      console.error('Error al evaluar diagnóstico legal para M14:', err);
    }

    // Renderizar la sección completa de planificación sucesoral
    const html = renderPlanSucesoral(hallazgos);

    if(!html || html.trim() === ''){
      // No hay datos suficientes. Guiar al usuario al M13.
      cont.innerHTML =
        '<div class="pf-note" style="text-align:center;padding:40px 24px;background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:12px">' +
        '<p style="margin:0 0 12px;font-size:14px;color:rgba(0,0,0,.72)">Para generar tu plan sucesoral necesitamos algunos datos primero.</p>' +
        '<p style="margin:0 0 20px;font-size:13px;color:rgba(0,0,0,.55)">Completa tu diagnóstico legal en el módulo anterior — sobre todo si tienes dependientes y cuánto necesitan al mes.</p>' +
        '<button class="pf-cta primary" style="min-width:220px" onclick="navigateTo(13)">Ir al diagnóstico legal</button>' +
        '</div>';
      return;
    }

    cont.innerHTML = html;

    // Listeners: CTAs de cotización → WhatsApp
    cont.querySelectorAll('[data-cta-cotizar]').forEach(b => {
      b.addEventListener('click', () => {
        const tipo = b.dataset.ctaCotizar;
        const monto = parseFloat(b.dataset.ctaMonto || 0);
        const tema = whatsappTemaLegal(tipo, monto);
        abrirWhatsAppAsesor(tema);
      });
    });
    // Checkboxes persistentes
    cont.querySelectorAll('.leg-plan-check').forEach(chk => {
      chk.addEventListener('change', function(){
        const id = this.dataset.accionId;
        if(!id) return;
        inicializarLegal();
        if(this.checked) state.fiscal.legal.planSucesoral.acciones[id] = true;
        else delete state.fiscal.legal.planSucesoral.acciones[id];
        const label = this.closest('.leg-plan-accion');
        if(label) label.classList.toggle('done', this.checked);
        scheduleSave('fiscal');
      });
    });
  }



  /* ═══════════════════════════════════════════════════════════════════════════
     PLANIFICACIÓN SUCESORAL
     Sección posterior al diagnóstico. Se renderiza automáticamente cuando el
     usuario ha llenado datos suficientes. Tiene 4 sub-secciones:
     A. Qué pasaría hoy si tú faltas (bienes financieros, inmuebles, empresa)
     B. Simulación de flujo de caja (cuánto tiempo aguanta la familia)
     C. Checklist de acciones ordenadas por prioridad (persistente en Firestore)
     D. CTAs de cotización + botón Contactar asesor
     ═══════════════════════════════════════════════════════════════════════════ */

  /* ─── SVGs consistentes con el resto de la app (estilo Feather) ─── */
  const ICONS_PLAN = {
    dinero:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    casa:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    empresa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/></svg>',
    escudo:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    balanza: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 8h14"/><path d="M8 8l-4 6c0 2 2 3 4 3s4-1 4-3l-4-6z"/><path d="M16 8l-4 6c0 2 2 3 4 3s4-1 4-3l-4-6z" transform="translate(4 0)"/></svg>',
    usuarios:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    documento:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    alerta:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    idea:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1 1 1.8V17h6v-.5c0-.8.4-1.4 1-1.8A7 7 0 0 0 12 2z"/></svg>',
    flecha:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
  };

  function renderPlanSucesoral(hallazgos){
    inicializarLegal();
    const L = state.fiscal.legal;
    const mapa = (typeof MapaPatrimonial !== 'undefined' && MapaPatrimonial.getData)
      ? MapaPatrimonial.getData() : { activos:[], activosNormalizados:[], resumen:{patrimonioBrutoCOP:0} };

    const activosDetalle = mapa.activos || [];
    const activosNorm = mapa.activosNormalizados || [];
    const normsByIdPS = new Map(activosNorm.map(a => [a._mapaId, a]));
    const totalDependientes = (L.hijosMenores||0) + (L.hijosMayoresDependientes||0) + (L.otrosDependientes||0);
    const patrimonioBruto = (mapa.resumen && mapa.resumen.patrimonioBrutoCOP) || 0;
    const smmlv = getSMMLV();

    // Mostrar planificación solo si hay algo material que planificar
    if(!totalDependientes && patrimonioBruto < smmlv * 200) return '';

    let html = '<div class="leg-plan">';

    /* ══ A. Qué pasaría hoy si tú faltas ══ */
    html += renderPlanQuePasaria(activosDetalle, normsByIdPS);

    /* ══ B. Simulación de flujo de caja ══ */
    if(totalDependientes > 0 && (L.gastoMensualFamilia||0) > 0){
      html += renderPlanFlujoCaja(activosNorm, L);
    }

    /* ══ C. Acciones ordenadas por prioridad (checklist) ══ */
    html += renderPlanAcciones(hallazgos, L, activosDetalle);

    /* ══ D. CTAs de cotización y contactar asesor ══ */
    html += renderPlanCTAs(hallazgos, L);

    html += '</div>';
    return html;
  }


  /* ─── A. Qué pasaría hoy si tú faltas ─── */
  function renderPlanQuePasaria(activosDetalle, normsByIdPS){
    let html = '<div class="leg-plan-sec">';
    html += '<h4 class="leg-plan-sec-t">Qué pasaría hoy si tú faltas</h4>';

    // ── Productos financieros ──
    const financieros = activosDetalle.filter(a => a.category === 'Financiero');
    if(financieros.length > 0){
      const total = financieros.reduce((s,a) => {
        const nrm = normsByIdPS.get(a.id);
        return s + (nrm ? nrm.valor : 0);
      }, 0);
      html += '<div class="leg-plan-box">';
      html += '<div class="leg-plan-box-h"><span class="leg-plan-ico">'+ICONS_PLAN.dinero+'</span><strong>Tus productos financieros</strong></div>';
      html += '<ul class="leg-plan-list">';
      financieros.forEach(a => {
        const nrm = normsByIdPS.get(a.id);
        const val = nrm ? nrm.valor : 0;
        html += '<li><strong>'+(a.description||a.subtype||'Producto financiero')+'</strong> — '+fmt(val)+'</li>';
      });
      html += '</ul>';
      html += '<div class="leg-plan-box-body">';
      html += '<p><strong>Total en productos financieros:</strong> '+fmt(total)+'</p>';
      html += '<p class="leg-plan-alert"><strong>Cómo acceden tus herederos hoy:</strong> nadie puede tocar ese dinero hasta que se abra la sucesión y un juez o notario les adjudique los bienes. El proceso toma entre 6 meses (notarial, sin conflicto) y 3 años (judicial, con desacuerdos). Los bancos exigen escritura de partición, certificado de defunción y certificado de vigencia de sucesión.</p>';
      html += '<p><strong>Dos rutas más rápidas si el monto es bajo:</strong></p>';
      html += '<ul class="leg-plan-sublist">';
      html += '<li><strong>Retiro directo del banco sin sucesión</strong> (Estatuto Orgánico del Sistema Financiero): si el saldo total de las cuentas y CDTs no supera aproximadamente <strong>$87 millones</strong> (cifra que la Superintendencia Financiera ajusta anualmente), el cónyuge, compañero permanente o herederos pueden solicitar el retiro directamente al banco. Requieren registro civil de defunción, registro civil de nacimiento del solicitante y declaración extrajuicio de únicos herederos. Es una facultad del banco, no una obligación.</li>';
      html += '<li><strong>Auxilio funerario de Colpensiones</strong> (si el fallecido era pensionado o cotizante activo): quien pagó los gastos funerarios reclama entre <strong>5 y 10 SMMLV</strong> (aprox. '+fmt(5*getSMMLV())+' a '+fmt(10*getSMMLV())+' en 2026) presentando la factura de la funeraria. Se solicita en Colpensiones dentro de los 12 meses siguientes al fallecimiento.</li>';
      html += '</ul>';
      html += '<p class="leg-plan-tip"><strong>Cómo agilizar el acceso al patrimonio completo:</strong></p>';
      html += '<ul class="leg-plan-sublist">';
      html += '<li>Cuenta bancaria conjunta con tu pareja (acceso inmediato al 50% que le corresponde por ley).</li>';
      html += '<li>Portafolios de inversión con beneficiarios designados (Skandia, Old Mutual, Sura Investment permiten esto).</li>';
      html += '<li>Fideicomiso mercantil con instrucciones específicas de entrega.</li>';
      html += '</ul>';
      html += '</div></div>';
    }

    // ── Inmuebles ──
    const inmuebles = activosDetalle.filter(a => a.category === 'Inmueble');
    if(inmuebles.length > 0){
      const total = inmuebles.reduce((s,a) => {
        const nrm = normsByIdPS.get(a.id);
        return s + (nrm ? nrm.valor : 0);
      }, 0);
      const UVT = 52374;
      const exVivienda = 13000 * UVT;
      const exOtros = 6500 * UVT;
      const exLegit = 3250 * UVT;
      html += '<div class="leg-plan-box">';
      html += '<div class="leg-plan-box-h"><span class="leg-plan-ico">'+ICONS_PLAN.casa+'</span><strong>Tus bienes inmuebles</strong></div>';
      html += '<ul class="leg-plan-list">';
      inmuebles.forEach(a => {
        const nrm = normsByIdPS.get(a.id);
        const val = nrm ? nrm.valor : 0;
        html += '<li><strong>'+(a.description||a.subtype||'Inmueble')+'</strong> — '+fmt(val)+'</li>';
      });
      html += '</ul>';
      html += '<div class="leg-plan-box-body">';
      html += '<p><strong>Total en inmuebles:</strong> '+fmt(total)+'</p>';
      html += '<p class="leg-plan-alert"><strong>Cómo se transfieren:</strong> por sucesión notarial (si hay acuerdo entre herederos) o judicial (si no hay acuerdo). Ambas duran varios meses. Mientras no se adjudiquen, los inmuebles siguen a tu nombre y no se pueden vender ni arrendar oficialmente.</p>';
      html += '<p><strong>Qué impuesto pagarían:</strong> quien hereda paga el 15% de lo que recibe, pero la ley perdona una parte antes de cobrar. Sobre la casa donde vivías no se cobra impuesto hasta '+fmt(exVivienda)+'; sobre los demás inmuebles, hasta '+fmt(exOtros)+'; y además cada hijo, padre o cónyuge tiene un descuento propio de '+fmt(exLegit)+'. Solo se paga el 15% sobre lo que quede por encima de eso.</p>';
      html += '</div></div>';
    }

    // ── Empresas ──
    const empresas = activosDetalle.filter(a => a.category === 'Empresarial');
    if(empresas.length > 0){
      html += '<div class="leg-plan-box">';
      html += '<div class="leg-plan-box-h"><span class="leg-plan-ico">'+ICONS_PLAN.empresa+'</span><strong>Tu participación empresarial</strong></div>';
      html += '<ul class="leg-plan-list">';
      empresas.forEach(a => {
        const nrm = normsByIdPS.get(a.id);
        const val = nrm ? nrm.valor : 0;
        const rol = a.rolEmpresarial ? ' · '+a.rolEmpresarial : '';
        html += '<li><strong>'+(a.description||a.subtype||'Empresa')+'</strong> — '+fmt(val)+rol+'</li>';
      });
      html += '</ul>';
      html += '<div class="leg-plan-box-body">';
      html += '<p class="leg-plan-alert"><strong>Qué pasa con la operación:</strong> las acciones o cuotas de la empresa entran a tu herencia. Mientras no se adjudiquen, no hay representante legal claro y la operación puede paralizarse. Contratos, empleados, clientes y proveedores quedan en incertidumbre.</p>';
      html += '<p>Los herederos reciben acciones proporcionales pero pueden no coincidir en visión (uno quiere vender, otro quiere seguir operando). Muchos negocios pierden valor sustancial durante este período.</p>';
      html += '<p class="leg-plan-tip"><strong>Qué puedes hacer AHORA:</strong></p>';
      html += '<ul class="leg-plan-sublist">';
      html += '<li>Cláusulas estatutarias sobre transmisión de acciones al fallecer un socio.</li>';
      html += '<li>Acuerdo con socios sobre valoración, opción de compra y sucesión operativa.</li>';
      html += '<li>Instrucciones específicas en tu testamento sobre quién administra la empresa.</li>';
      html += '<li>Fideicomiso mercantil que administre profesionalmente hasta que los herederos estén listos.</li>';
      html += '</ul>';
      html += '</div></div>';
    }

    html += '</div>';   // fin leg-plan-sec
    return html;
  }


  /* ─── B. Simulación de flujo de caja post-fallecimiento ─── */
  function renderPlanFlujoCaja(activosNorm, L){
    const activosLiquidos = activosNorm.filter(a => a.tipo === 'LÍQUIDO' && !a.restringido)
      .reduce((s,a) => s + (a.valor||0), 0);
    const gastoMensual = L.gastoMensualFamilia || 0;
    if(gastoMensual <= 0) return '';

    // Ruta rápida de acceso a saldos bancarios sin sucesión (~$87M, se ajusta anualmente)
    const topeRetiroDirecto = 87000000;
    const mesesConLiquidezActual = Math.floor(activosLiquidos / gastoMensual);
    const gastoAnual = gastoMensual * 12;

    // Suma asegurada sugerida: entre 5 y 10 años de gasto familiar
    const sugerido5anios = gastoAnual * 5;
    const sugerido10anios = gastoAnual * 10;

    let html = '<div class="leg-plan-sec">';
    html += '<h4 class="leg-plan-sec-t">Simulación · Flujo de caja de tu familia si tú faltas</h4>';

    html += '<div class="leg-plan-flujo">';
    html += '<div class="leg-plan-flujo-row"><span>Gasto mensual de tu familia:</span><strong>'+fmt(gastoMensual)+'</strong></div>';
    html += '<div class="leg-plan-flujo-row"><span>Gasto anual total:</span><strong>'+fmt(gastoAnual)+'</strong></div>';
    html += '<div class="leg-plan-flujo-row"><span>Liquidez disponible (cuentas, CDTs, portafolios):</span><strong>'+fmt(activosLiquidos)+'</strong></div>';
    if(activosLiquidos <= topeRetiroDirecto){
      html += '<div class="leg-plan-flujo-row"><span>Acceso sin sucesión (si saldos &lt; $87M):</span><strong>Posible</strong></div>';
    } else {
      html += '<div class="leg-plan-flujo-row"><span>Acceso sin sucesión (saldos &gt; $87M):</span><strong>Requiere sucesión formal</strong></div>';
    }
    html += '</div>';

    // Análisis del gap
    if(mesesConLiquidezActual < 12){
      html += '<div class="leg-plan-danger">';
      html += '<div class="leg-plan-danger-t"><span class="leg-plan-sev-ico">'+ICONS_PLAN.alerta+'</span> Déficit crítico</div>';
      html += '<p>Tu familia solo tendría liquidez para aproximadamente <strong>'+mesesConLiquidezActual+' mes'+(mesesConLiquidezActual!==1?'es':'')+'</strong> — y eso <em>si</em> pudieran acceder al dinero, cosa que en Colombia toma meses después de abrir la sucesión.</p>';
      html += '<p>El déficit acumulado a 12 meses sería de aproximadamente <strong>'+fmt(Math.max(0, gastoAnual - activosLiquidos))+'</strong>. Ese dinero saldría de préstamos familiares, venta forzada de bienes a bajo precio, o simplemente ajuste dramático del nivel de vida.</p>';
      html += '</div>';
    } else if(mesesConLiquidezActual < 60){
      html += '<div class="leg-plan-warning">';
      html += '<div class="leg-plan-warning-t"><span class="leg-plan-sev-ico">'+ICONS_PLAN.alerta+'</span> Cobertura parcial</div>';
      html += '<p>Tu familia podría sostenerse aproximadamente <strong>'+mesesConLiquidezActual+' meses</strong> con la liquidez actual (siempre que puedan acceder rápido). Después de eso, dependen de vender bienes ilíquidos, lo cual toma tiempo y suele hacerse a precio de urgencia.</p>';
      html += '</div>';
    } else {
      html += '<div class="leg-plan-ok">';
      html += '<div class="leg-plan-ok-t"><span class="leg-plan-sev-ico">'+ICONS_PLAN.check+'</span> Buena cobertura de liquidez</div>';
      html += '<p>Tu familia tendría liquidez para más de <strong>'+Math.floor(mesesConLiquidezActual/12)+' años</strong>. Aun así, recuerda que en Colombia el acceso a esos recursos no es inmediato: se requiere abrir la sucesión.</p>';
      html += '</div>';
    }

    // Recomendación de seguro
    html += '<div class="leg-plan-recom">';
    html += '<div class="leg-plan-recom-t"><span class="leg-plan-sev-ico">'+ICONS_PLAN.idea+'</span> Recomendación de seguro de vida</div>';
    html += '<p>Un seguro de vida entrega efectivo directamente a los beneficiarios en menos de 30 días, sin pasar por sucesión. En Colombia, el pago está <strong>exento de impuestos hasta '+fmt(3250*52374)+'</strong> (Art. 303-1 ET).</p>';
    html += '<p>Con base en el gasto mensual de tu familia, tu suma asegurada ideal sería:</p>';
    html += '<div class="leg-plan-recom-tabla">';
    html += '<div class="leg-plan-recom-cell"><div class="leg-plan-recom-label">Cobertura básica (5 años)</div><div class="leg-plan-recom-val">'+fmt(sugerido5anios)+'</div></div>';
    html += '<div class="leg-plan-recom-cell primary"><div class="leg-plan-recom-label">Cobertura recomendada (10 años)</div><div class="leg-plan-recom-val">'+fmt(sugerido10anios)+'</div></div>';
    html += '</div>';
    html += '<p class="leg-plan-recom-nota">Costo referencial de una póliza temporal a 20 años: entre 0,3% y 1,5% de la suma asegurada al año. Por ejemplo, una póliza de '+fmt(sugerido10anios)+' costaría entre '+fmt(Math.round(sugerido10anios*0.003))+' y '+fmt(Math.round(sugerido10anios*0.015))+' al año.</p>';
    html += '<button class="pf-cta-mini" data-cta-cotizar="seguro_vida" data-cta-monto="'+sugerido10anios+'">Cotizar mi seguro de vida ideal</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }


  /* ─── C. Acciones ordenadas por prioridad (checklist persistente) ─── */
  function renderPlanAcciones(hallazgos, L, activosDetalle){
    const acciones = generarAccionesPlan(hallazgos, L, activosDetalle);
    if(acciones.length === 0) return '';

    let html = '<div class="leg-plan-sec">';
    html += '<h4 class="leg-plan-sec-t">Acciones ordenadas por prioridad</h4>';
    html += '<p class="leg-plan-sec-sub">Marca las acciones a medida que las vas completando. Tu progreso se guarda automáticamente.</p>';

    // Agrupar por prioridad
    const grupos = { alta: [], media: [], baja: [] };
    acciones.forEach(a => { grupos[a.prioridad].push(a); });

    const labelsGrupos = {
      alta: { txt:'Hacer este mes', color:'alta' },
      media:{ txt:'Hacer este trimestre', color:'media' },
      baja: { txt:'Evaluar con asesor (6-12 meses)', color:'baja' }
    };

    ['alta','media','baja'].forEach(pri => {
      if(grupos[pri].length === 0) return;
      const lbl = labelsGrupos[pri];
      html += '<div class="leg-plan-priog leg-plan-priog-'+lbl.color+'">';
      html += '<div class="leg-plan-priog-h"><span class="leg-plan-priog-dot"></span>'+lbl.txt+'</div>';
      grupos[pri].forEach(a => {
        const checked = !!(L.planSucesoral && L.planSucesoral.acciones && L.planSucesoral.acciones[a.id]);
        html += '<label class="leg-plan-accion'+(checked?' done':'')+'" data-accion-id="'+a.id+'">';
        html += '<input type="checkbox" class="leg-plan-check"'+(checked?' checked':'')+' data-accion-id="'+a.id+'">';
        html += '<div class="leg-plan-accion-body">';
        html += '  <div class="leg-plan-accion-t">'+a.titulo+'</div>';
        html += '  <div class="leg-plan-accion-d">'+a.descripcion+'</div>';
        if(a.costo){
          html += '  <div class="leg-plan-accion-meta">'+a.costo+'</div>';
        }
        html += '</div>';
        html += '</label>';
      });
      html += '</div>';
    });

    html += '</div>';
    return html;
  }


  /* ─── Generación dinámica de acciones basadas en el diagnóstico ─── */
  function generarAccionesPlan(hallazgos, L, activosDetalle){
    const acciones = [];
    const hallazgosIds = new Set(hallazgos.map(h => h.id.split('_').slice(0,2).join('_')));
    // También identificamos por prefijo R# porque algunos IDs traen sufijo con id de activo
    const tieneRegla = (prefix) => hallazgos.some(h => h.id.startsWith(prefix));

    // 🔴 Prioridad ALTA (este mes)
    if(tieneRegla('R6_sin_testamento')){
      acciones.push({
        id:'testamento',
        prioridad:'alta',
        titulo:'Otorgar testamento en notaría',
        descripcion:'Pide cita en cualquier notaría. Lleva tu cédula y una lista de tus bienes y a quiénes quieres dejar qué. En una sola visita queda protocolizado.',
        costo:'Costo: $200.000 a $500.000 · Duración: 1 día'
      });
    }
    if(tieneRegla('R21_iliquidez')){
      acciones.push({
        id:'seguro_vida',
        prioridad:'alta',
        titulo:'Cotizar seguro de vida para tu familia',
        descripcion:'Solicita cotizaciones a mínimo 3 aseguradoras (Sura, Bolívar, Liberty). Como referencia, la suma asegurada debe cubrir entre 5 y 10 años de gastos de tu familia.',
        costo:'Costo: entre 0,3% y 1,5% de la suma asegurada al año'
      });
    }
    if(tieneRegla('R5_pleito_demandado')){
      acciones.push({
        id:'defensa_pleito',
        prioridad:'alta',
        titulo:'Fortalecer tu defensa en el proceso judicial',
        descripcion:'Prioriza contratar un buen abogado especializado en el tipo de proceso. No hagas movimientos patrimoniales durante el pleito — se pueden anular por fraude a acreedores.',
        costo:'Costo: honorarios de abogado según proceso'
      });
    }
    if(tieneRegla('R23_sin_rc') && !(L.coberturas && L.coberturas.rcProfesional && L.coberturas.rcProfesional.tiene === true)){
      acciones.push({
        id:'poliza_rc',
        prioridad:'alta',
        titulo:'Cotizar póliza de Responsabilidad Civil Profesional',
        descripcion:'Con tu actividad económica de riesgo, esta póliza cubre tu defensa jurídica y condenas si un cliente te demanda por errores profesionales.',
        costo:'Costo anual: entre 0,5% y 2% de tu facturación anual'
      });
    }
    if(tieneRegla('R24_sin_dyo') && !(L.coberturas && L.coberturas.dyo && L.coberturas.dyo.tiene === true)){
      acciones.push({
        id:'poliza_dyo',
        prioridad:'alta',
        titulo:'Cotizar póliza D&O (para administradores)',
        descripcion:'Con tu rol de administrador en una empresa, esta póliza cubre tu patrimonio personal si te demandan por decisiones tomadas en ese rol.',
        costo:'Costo anual: entre $3M y $30M según tamaño de la empresa'
      });
    }

    // 🟡 Prioridad MEDIA (este trimestre)
    if(tieneRegla('R10_seguro_ben_legales') || ((L.segurosVida||[]).length === 0 && (L.hijosMenores||0)+(L.hijosMayoresDependientes||0) > 0)){
      // Solo si tiene seguros con beneficiarios legales, o si no tiene seguros pero sí dependientes
      if(tieneRegla('R10_seguro')){
        acciones.push({
          id:'beneficiarios_seguros',
          prioridad:'media',
          titulo:'Designar beneficiarios específicos en tus seguros',
          descripcion:'Llama a cada aseguradora y pide el formato de designación. Nombra personas con nombre, cédula y porcentaje. Es gratis y toma minutos.',
          costo:'Costo: gratuito'
        });
      }
    }
    // Beneficiarios en productos financieros (si tiene productos financieros y no ha marcado la acción)
    const tieneFinancierosAltos = activosDetalle.some(a => a.category === 'Financiero');
    if(tieneFinancierosAltos){
      acciones.push({
        id:'beneficiarios_productos',
        prioridad:'media',
        titulo:'Designar beneficiarios en portafolios y CDTs',
        descripcion:'Skandia, Old Mutual y Sura Investment permiten designar beneficiarios en portafolios de inversión. Con esto tus herederos reciben directo, sin pasar por sucesión.',
        costo:'Costo: gratuito · Duración: llamada de 15 min por entidad'
      });
    }
    if(!L.poderes || !L.poderes.generalAdmin){
      acciones.push({
        id:'poder_general',
        prioridad:'media',
        titulo:'Otorgar poder general de administración',
        descripcion:'Le permite a tu pareja o familiar de confianza hacer trámites por ti (bancos, DIAN, notarías) si tienes un accidente o enfermedad que te incapacite.',
        costo:'Costo: $200.000 a $400.000 en notaría'
      });
    }
    if(tieneRegla('R22_sin_directiva') || (!L.poderes || !L.poderes.directivaAnticipada)){
      acciones.push({
        id:'directiva_anticipada',
        prioridad:'media',
        titulo:'Otorgar voluntad anticipada médica',
        descripcion:'Documento donde defines qué tratamientos médicos aceptas o rechazas si un día no puedes hablar por ti. Se firma en notaría o con tu médico tratante.',
        costo:'Costo: $150.000 a $300.000 en notaría'
      });
    }
    if(tieneRegla('R8_sociedad_conyugal')){
      acciones.push({
        id:'documentar_origen_bienes',
        prioridad:'media',
        titulo:'Documentar el origen de tus bienes propios',
        descripcion:'Reúne extractos bancarios, escrituras, testamentos o contratos de donación que prueben qué bienes son "propios" (anteriores al matrimonio o por herencia). Evita disputas futuras.',
        costo:'Costo: gratuito · Solo requiere organización'
      });
    }

    // 🟢 Prioridad BAJA (6-12 meses, con asesor)
    if(tieneRegla('R1_negocio') || tieneRegla('R2_renta') || tieneRegla('R16_concentracion')){
      acciones.push({
        id:'estructura_societaria',
        prioridad:'baja',
        titulo:'Evaluar estructura societaria para bienes personales',
        descripcion:'Consulta con contador y abogado si te conviene crear una SAS para tu actividad económica o para tus bienes productivos. Corre el simulador SAS del Perfil Fiscal para ver los números.',
        costo:'Constitución: $600k-$1,2M · Mantenimiento anual: $4-7M'
      });
    }
    if(tieneRegla('R11_empresa_familiar')){
      acciones.push({
        id:'protocolo_familiar',
        prioridad:'baja',
        titulo:'Diseñar protocolo o acuerdo de accionistas',
        descripcion:'Con abogado societario, define por escrito qué pasa con la empresa si tú faltas: quién administra, cómo se valoran las acciones, qué opciones tienen los herederos.',
        costo:'Costo: $2M a $8M según complejidad'
      });
    }
    if(tieneRegla('R18_copropiedad')){
      acciones.push({
        id:'acuerdo_copropiedad',
        prioridad:'baja',
        titulo:'Firmar acuerdo escrito con copropietarios',
        descripcion:'Define quién administra, cómo se toman decisiones, derecho de preferencia si alguno vende, y qué pasa si uno de ustedes fallece.',
        costo:'Costo: $500k a $2M por redacción del acuerdo'
      });
    }
    if(tieneRegla('R17_concentracion_vehiculo') || tieneRegla('R19')){
      acciones.push({
        id:'holding',
        prioridad:'baja',
        titulo:'Evaluar creación de holding patrimonial',
        descripcion:'Con contador tributarista, corre los números para una SAS holding que agrupe tu operativa, tus inmuebles productivos y tus inversiones. Beneficios tributarios (art. 246-1 ET) y sucesorales.',
        costo:'Aporte de bienes: $5-20M · Mantenimiento: $5-10M/año'
      });
    }
    if(tieneRegla('R20_fideicomiso')){
      acciones.push({
        id:'fideicomiso',
        prioridad:'baja',
        titulo:'Evaluar fideicomiso mercantil',
        descripcion:'Con fiduciaria (Alianza, Fiduagraria, Skandia), estructura un fideicomiso que administre profesionalmente los bienes para tus hijos menores hasta cierta edad.',
        costo:'Constitución: $8-20M · Comisión anual: 0,5% a 1,5% de activos'
      });
    }

    return acciones;
  }


  /* ─── D. CTAs de cotización + Contactar asesor ─── */
  function renderPlanCTAs(hallazgos, L){
    const tieneRegla = (prefix) => hallazgos.some(h => h.id.startsWith(prefix));
    const necesitaSegVida = tieneRegla('R21_iliquidez') || tieneRegla('R6_sin_testamento') || ((L.hijosMenores||0)+(L.hijosMayoresDependientes||0) > 0 && (L.segurosVida||[]).length === 0);
    const necesitaRC = tieneRegla('R23_sin_rc') && !(L.coberturas && L.coberturas.rcProfesional && L.coberturas.rcProfesional.tiene === true);
    const necesitaDyo = tieneRegla('R24_sin_dyo') && !(L.coberturas && L.coberturas.dyo && L.coberturas.dyo.tiene === true);
    const necesitaAsesorLegal = tieneRegla('R1_negocio') || tieneRegla('R11_empresa') || tieneRegla('R17') || tieneRegla('R18') || tieneRegla('R19') || tieneRegla('R20');

    let html = '<div class="leg-plan-sec leg-plan-ctas">';
    html += '<h4 class="leg-plan-sec-t">Servicios recomendados según tu perfil</h4>';
    html += '<p class="leg-plan-sec-sub">Cotiza o agenda directamente con un asesor especializado. Toda la información va por WhatsApp con contexto de tu diagnóstico.</p>';

    html += '<div class="leg-plan-ctas-grid">';

    if(necesitaSegVida){
      html += '<div class="leg-plan-cta-card">';
      html += '<div class="leg-plan-cta-ico">'+ICONS_PLAN.escudo+'</div>';
      html += '<div class="leg-plan-cta-t">Cotizar seguro de vida</div>';
      html += '<div class="leg-plan-cta-d">Liquidez inmediata para tu familia. Exento hasta '+fmt(3250*52374)+'.</div>';
      html += '<button class="pf-cta-mini" data-cta-cotizar="seguro_vida">Cotizar</button>';
      html += '</div>';
    }
    if(necesitaRC){
      html += '<div class="leg-plan-cta-card">';
      html += '<div class="leg-plan-cta-ico">'+ICONS_PLAN.balanza+'</div>';
      html += '<div class="leg-plan-cta-t">Cotizar RC profesional</div>';
      html += '<div class="leg-plan-cta-d">Cubre tu defensa y condenas por errores profesionales.</div>';
      html += '<button class="pf-cta-mini" data-cta-cotizar="rc_profesional">Cotizar</button>';
      html += '</div>';
    }
    if(necesitaDyo){
      html += '<div class="leg-plan-cta-card">';
      html += '<div class="leg-plan-cta-ico">'+ICONS_PLAN.usuarios+'</div>';
      html += '<div class="leg-plan-cta-t">Cotizar póliza D&O</div>';
      html += '<div class="leg-plan-cta-d">Protege tu patrimonio como administrador de empresas.</div>';
      html += '<button class="pf-cta-mini" data-cta-cotizar="dyo">Cotizar</button>';
      html += '</div>';
    }
    if(tieneRegla('R6_sin_testamento') || tieneRegla('R7_testamento_viejo')){
      html += '<div class="leg-plan-cta-card">';
      html += '<div class="leg-plan-cta-ico">'+ICONS_PLAN.documento+'</div>';
      html += '<div class="leg-plan-cta-t">Asesoría para testamento</div>';
      html += '<div class="leg-plan-cta-d">Un abogado revisa tu situación y te acompaña al proceso notarial.</div>';
      html += '<button class="pf-cta-mini" data-cta-cotizar="testamento">Solicitar</button>';
      html += '</div>';
    }
    if(necesitaAsesorLegal){
      html += '<div class="leg-plan-cta-card">';
      html += '<div class="leg-plan-cta-ico">'+ICONS_PLAN.balanza+'</div>';
      html += '<div class="leg-plan-cta-t">Asesoría legal societaria</div>';
      html += '<div class="leg-plan-cta-d">Estructuración de SAS, holding, protocolos familiares y acuerdos.</div>';
      html += '<button class="pf-cta-mini" data-cta-cotizar="asesor_legal">Solicitar</button>';
      html += '</div>';
    }

    html += '</div>';   // fin ctas-grid

    // Botón grande principal: contactar asesor patrimonial
    html += '<div class="leg-plan-contact">';
    html += '<div class="leg-plan-contact-body">';
    html += '<div class="leg-plan-contact-t">¿Quieres una asesoría patrimonial completa?</div>';
    html += '<div class="leg-plan-contact-d">Un asesor revisa tu diagnóstico, aterriza el plan a tu situación específica y te acompaña en la implementación paso a paso.</div>';
    html += '</div>';
    html += '<button class="pf-cta primary leg-plan-contact-btn" data-cta-cotizar="asesor_patrimonial">Hablar con un asesor patrimonial '+ICONS_PLAN.flecha+'</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }


  /* ─── Mensajes de WhatsApp por tipo de CTA ─── */
  function whatsappTemaLegal(tipo, monto){
    const map = {
      seguro_vida:       'Cotización de seguro de vida' + (monto ? ' (suma asegurada de referencia: '+fmt(monto)+')' : ''),
      rc_profesional:    'Cotización de póliza de Responsabilidad Civil Profesional',
      dyo:               'Cotización de póliza D&O para administradores',
      testamento:        'Asesoría para otorgar testamento',
      asesor_legal:      'Asesoría legal societaria (estructuración, protocolos, acuerdos)',
      asesor_patrimonial:'Asesoría patrimonial completa · vengo del módulo Estructura Legal Patrimonial'
    };
    return map[tipo] || 'Módulo Estructura Legal Patrimonial';
  }

  function categoriaLabelLeg(cat){
    return {
      proteccion:'Protección patrimonial',
      sucesion:'Sucesión',
      cumplimiento:'Cumplimiento',
      concentracion:'Concentración',
      vehiculo:'Vehículo apropiado'
    }[cat] || cat;
  }


  /* ═════ WIRING ═════ */
  function wireEstructuraLegal(){
    const L = () => state.fiscal.legal;
    const persist = () => { scheduleSave('fiscal'); renderDiagnosticoLegal(); };

    const eciv = document.getElementById('leg-estado-civil');
    if(eciv) eciv.addEventListener('change', function(){
      L().estadoCivil = this.value;
      toggleShowLeg('leg-regimen-wrap', this.value === 'casado' || this.value === 'union_marital');
      toggleShowLeg('leg-anio-union-wrap', this.value === 'union_marital');
      persist();
    });
    const reg = document.getElementById('leg-regimen-conyugal');
    if(reg) reg.addEventListener('change', function(){ L().regimenConyugal = this.value; persist(); });
    const anio = document.getElementById('leg-anio-union');
    if(anio) anio.addEventListener('input', function(){ L().anioMatrimonioUnion = this.value.replace(/[^0-9]/g,'').slice(0,4); persist(); });

    ['leg-hijos-menores','leg-hijos-mayores','leg-otros-dep'].forEach(id => {
      const el = document.getElementById(id); if(!el) return;
      el.addEventListener('input', function(){
        const v = parseInt(this.value.replace(/[^0-9]/g,''), 10) || 0;
        if(id==='leg-hijos-menores') L().hijosMenores = v;
        if(id==='leg-hijos-mayores') L().hijosMayoresDependientes = v;
        if(id==='leg-otros-dep') L().otrosDependientes = v;
        // Refrescar visibilidad de la pregunta de gasto familiar
        const tot = (L().hijosMenores||0) + (L().hijosMayoresDependientes||0) + (L().otrosDependientes||0);
        toggleShowLeg('leg-gasto-familia-wrap', tot > 0);
        persist();
      });
    });

    const gastoFam = document.getElementById('leg-gasto-familia');
    if(gastoFam){
      attachMoneyInput(gastoFam);
      gastoFam.addEventListener('input', function(){
        L().gastoMensualFamilia = n(this.value);
        persist();
      });
    }

    const test = document.getElementById('leg-testamento-tiene');
    if(test) test.addEventListener('change', function(){
      L().testamento.tiene = this.value === 'si' ? true : (this.value === 'no' ? false : null);
      toggleShowLeg('leg-testamento-detalle', this.value === 'si');
      persist();
    });
    const testTipo = document.getElementById('leg-testamento-tipo');
    if(testTipo) testTipo.addEventListener('change', function(){ L().testamento.tipo = this.value; persist(); });
    const testAnio = document.getElementById('leg-testamento-anio');
    if(testAnio) testAnio.addEventListener('input', function(){
      L().testamento.anioOtorgamiento = this.value.replace(/[^0-9]/g,'').slice(0,4);
      persist();
    });
    const testRev = document.getElementById('leg-testamento-revisado');
    if(testRev) testRev.addEventListener('change', function(){
      L().testamento.revisadoTrasCambios = this.value === 'si' ? true : (this.value === 'no' ? false : null);
      persist();
    });

    const pAdmin = document.getElementById('leg-poder-admin');
    if(pAdmin) pAdmin.addEventListener('click', function(e){
      if(e.target.closest('.info-tip')) return;
      L().poderes.generalAdmin = !L().poderes.generalAdmin;
      this.classList.toggle('on', L().poderes.generalAdmin);
      persist();
    });
    const pDir = document.getElementById('leg-poder-directiva');
    if(pDir) pDir.addEventListener('click', function(e){
      if(e.target.closest('.info-tip')) return;
      L().poderes.directivaAnticipada = !L().poderes.directivaAnticipada;
      this.classList.toggle('on', L().poderes.directivaAnticipada);
      persist();
    });

    const btnAddSeg = document.getElementById('leg-add-seguro');
    if(btnAddSeg) btnAddSeg.addEventListener('click', function(){
      L().segurosVida.push({ aseguradora:'', sumaAsegurada:0, beneficiarios:'' });
      renderSegurosVida(); persist();
    });

    const avT = document.getElementById('leg-avales-tiene');
    if(avT) avT.addEventListener('change', function(){
      L().avalesTerceros.tiene = this.value === 'si' ? true : (this.value === 'no' ? false : null);
      toggleShowLeg('leg-avales-detalle', this.value === 'si');
      persist();
    });
    const avM = document.getElementById('leg-avales-monto');
    if(avM){ attachMoneyInput(avM); avM.addEventListener('input', function(){ L().avalesTerceros.monto = n(this.value); persist(); }); }
    const avD = document.getElementById('leg-avales-descripcion');
    if(avD) avD.addEventListener('input', function(){ L().avalesTerceros.detalle = this.value; persist(); });

    // ── Bloque 7 · blindaje del patrimonio y del ingreso ──
    const invT = document.getElementById('leg-invalidez-tiene');
    if(invT) invT.addEventListener('change', function(){
      L().coberturas = L().coberturas || {};
      L().coberturas.invalidez = L().coberturas.invalidez || {};
      L().coberturas.invalidez.tiene = this.value === 'si' ? true : (this.value === 'no' ? false : null);
      toggleShowLeg('leg-invalidez-monto-wrap', this.value === 'si');
      persist();
    });
    const invM = document.getElementById('leg-invalidez-monto');
    if(invM){ attachMoneyInput(invM); invM.addEventListener('input', function(){
      L().coberturas = L().coberturas || {}; L().coberturas.invalidez = L().coberturas.invalidez || {};
      L().coberturas.invalidez.rentaMensual = n(this.value); persist(); }); }
    const vpS = document.getElementById('leg-vivienda-protegida');
    if(vpS) vpS.addEventListener('change', function(){
      L().viviendaProtegida = this.value === 'si' ? true : (this.value === 'no' ? false : null); persist(); });
    const avSoc = document.getElementById('leg-aval-sociedad');
    if(avSoc) avSoc.addEventListener('change', function(){
      L().avalSociedad = this.value === 'si' ? true : (this.value === 'no' ? false : null); persist(); });
    const protF = document.getElementById('leg-protocolo-familiar');
    if(protF) protF.addEventListener('change', function(){
      L().protocoloFamiliar = this.value === 'si' ? true : (this.value === 'no' ? false : null); persist(); });
    const guar = document.getElementById('leg-guarda-designada');
    if(guar) guar.addEventListener('change', function(){
      L().guardaDesignada = this.value === 'si' ? true : (this.value === 'no' ? false : null); persist(); });

    const plT = document.getElementById('leg-pleitos-tiene');
    if(plT) plT.addEventListener('change', function(){
      L().pleitosVigentes.tieneComoDemandado = this.value === 'si' ? true : (this.value === 'no' ? false : null);
      toggleShowLeg('leg-pleitos-detalle', this.value === 'si');
      persist();
    });
    const plM = document.getElementById('leg-pleitos-monto');
    if(plM){ attachMoneyInput(plM); plM.addEventListener('input', function(){ L().pleitosVigentes.montoPretensiones = n(this.value); persist(); }); }
    const plD = document.getElementById('leg-pleitos-descripcion');
    if(plD) plD.addEventListener('input', function(){ L().pleitosVigentes.detalle = this.value; persist(); });

    const f160 = document.getElementById('leg-form160-presentado');
    if(f160) f160.addEventListener('change', function(){
      L().cumplimientoExterior.formulario160Presentado =
        this.value === 'si' ? true : (this.value === 'no' ? false : null);
      persist();
    });
    const ece = document.getElementById('leg-ece');
    if(ece) ece.addEventListener('click', function(e){
      if(e.target.closest('.info-tip')) return;
      L().cumplimientoExterior.tieneVehiculoECE = !L().cumplimientoExterior.tieneVehiculoECE;
      this.classList.toggle('on', L().cumplimientoExterior.tieneVehiculoECE);
      persist();
    });

    // ─── Coberturas (RC profesional + D&O) ───
    const rcT = document.getElementById('leg-rc-tiene');
    if(rcT) rcT.addEventListener('change', function(){
      L().coberturas.rcProfesional.tiene =
        this.value === 'si' ? true :
        this.value === 'no' ? false :
        this.value === 'no_se' ? 'no_se' : null;
      toggleShowLeg('leg-rc-monto-wrap', this.value === 'si');
      persist();
    });
    const rcM = document.getElementById('leg-rc-monto');
    if(rcM){
      attachMoneyInput(rcM);
      rcM.addEventListener('input', function(){
        L().coberturas.rcProfesional.sumaAsegurada = n(this.value);
        persist();
      });
    }

    const dyoT = document.getElementById('leg-dyo-tiene');
    if(dyoT) dyoT.addEventListener('change', function(){
      L().coberturas.dyo.tiene =
        this.value === 'si' ? true :
        this.value === 'no' ? false :
        this.value === 'no_se' ? 'no_se' : null;
      toggleShowLeg('leg-dyo-quien-wrap', this.value === 'si');
      persist();
    });
    const dyoQ = document.getElementById('leg-dyo-quien');
    if(dyoQ) dyoQ.addEventListener('change', function(){
      L().coberturas.dyo.quienContrata = this.value;
      persist();
    });
  }


  /* ═════ EXPOSICIÓN AL WINDOW (opcional, para debug) ═════ */
  if(typeof window !== 'undefined'){
    window.__renderEstructuraLegal = renderEstructuraLegal;
    window.__evaluarEstructuraLegal = evaluarEstructuraLegal;
    window.__renderModulo14 = renderModulo14;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     FIN DEL MÓDULO 13
     ═══════════════════════════════════════════════════════════════════════════ */

  const DEFINITIONS = {
    regimen_fiscal: { title:'Régimen tributario', text:'Define cómo pagas tus impuestos. En el <strong>Ordinario</strong> declaras renta por el sistema cedular. En el <strong>Simple (RST)</strong> pagas una sola tarifa sobre tus ingresos brutos que integra renta e ICA, en anticipos bimestrales. Si no sabes cuál tienes, lo leemos de tu RUT.' },
    resp_iva: { title:'Responsable de IVA', text:'Significa que debes cobrar el IVA en tus ventas y declararlo a la DIAN. Aplica, en general, si superas ~3.500 UVT de ingresos o tienes varios establecimientos. Si lo eres y no facturas IVA, hay sanción.' },
    resp_retencion: { title:'Agente de retención', text:'Eres tú quien <strong>retiene</strong> impuesto a quienes les pagas y lo declara mensualmente. La mayoría de personas naturales no lo son, salvo que cumplan topes de patrimonio o ingresos. Marca esto solo si aparece en tu RUT.' },
    resp_ica: { title:'ICA · Industria y Comercio', text:'Impuesto municipal sobre los ingresos de tu actividad. La tarifa y el calendario los fija cada municipio (por mil). Además te pueden practicar ReteICA, que luego descuentas.' },
    resp_exogena: { title:'Información exógena', text:'Es un reporte detallado de tus operaciones con terceros (a quién le pagaste, quién te pagó, retenciones) que la DIAN usa para cruzar información. Una persona natural queda obligada si tuvo ingresos brutos sobre 11.800 UVT (~$620 millones) y rentas de capital o no laborales sobre 2.400 UVT; o si practicó retención en la fuente, sin importar cuánto ganó. Se presenta entre mayo y junio según el NIT. Presentarla tarde o con errores tiene sanción (mínima 10 UVT).' },
    fiscal_consumos: { title:'Consumos con tarjeta', text:'El total que gastaste con tarjeta de crédito en el año. Lo encuentras en el <strong>extracto o certificado anual de tu tarjeta de crédito</strong> (tu banco lo emite para la declaración). Si supera 1.400 UVT (~$73 millones), quedas obligado a declarar renta aunque tus ingresos sean bajos.' },
    fiscal_consignaciones: { title:'Consignaciones y depósitos', text:'Todo lo que entró a tus cuentas bancarias en el año. Lo encuentras en el <strong>certificado anual que emite tu banco</strong> (suma todas tus cuentas). Ojo: incluye traslados entre tus propias cuentas, que pueden inflar la cifra pero se explican ante la DIAN. Si supera 1.400 UVT te obliga a declarar; y si es muy superior a tus ingresos, es una señal que la DIAN revisa.' },
    fiscal_compras: { title:'Compras y consumos totales', text:'El valor total de todo lo que compraste y consumiste en el año, por cualquier medio (efectivo, transferencias, débito, no solo tarjeta de crédito). Si supera 1.400 UVT (~$73 millones), te obliga a declarar renta, aunque tus ingresos sean bajos. Es un criterio distinto al de la tarjeta de crédito. Como referencia, tus gastos registrados en la app te dan un punto de partida; ajústalo con tus extractos.' },
    costo_fiscal: { title:'Costo fiscal', text:'No es lo que vale hoy tu activo: es el valor <strong>con el que la DIAN reconoce que lo adquiriste</strong>. Cuando vendes, el impuesto se calcula sobre la diferencia entre el precio de venta y el costo fiscal. Entre más alto sea, <strong>menos impuesto pagas</strong>. Por eso lo calculamos por ti.' },
    avaluo_catastral: { title:'Avalúo catastral', text:'El valor que el municipio le asigna a tu inmueble; aparece en el recibo del predial. La ley (art. 72) permite usarlo como costo fiscal, lo que muchas veces conviene más que el precio de compra.' },
    aporte_voluntario_fiscal: { title:'Aportes voluntarios a FPV / AFC', text:'Lo que aportas en el año a un fondo de pensiones voluntarias (FPV) o a una cuenta AFC es <strong>renta exenta</strong>, hasta el 30% de tu ingreso sin pasar de 3.800 UVT (y dentro del límite global del 40% / 1.340 UVT). La app conoce el saldo de tu FPV/AFC, pero no cuánto aportaste este año: por eso lo registras aquí.' },
    gmf_fiscal: { title:'4x1000 (GMF)', text:'El gravamen a los movimientos financieros (4 por mil) que pagas en el año es <strong>deducible en un 50%</strong> (art. 115 ET), sin necesidad de que tenga relación con tu actividad. Registra aquí el total de 4x1000 que figura en tus certificados bancarios; la app deduce la mitad.' },
    simple_residente: { title:'Vivir en Colombia', text:'El Régimen Simple es solo para quienes <strong>viven en Colombia la mayor parte del año</strong>. Si pasas más de la mitad del año fuera del país, no puedes usarlo.' },
    simple_actividad: { title:'Actividades que no pueden usar el Simple', text:'El Simple <strong>no</strong> lo pueden usar quienes se dedican principalmente a: asesorar en inversiones o créditos, comprar y vender inversiones o activos, prestar plata (como factoring o microcrédito), generar o vender energía eléctrica, vender carros, vender combustibles, o fabricar o vender armas. Si tu trabajo principal es uno de estos, no aplica.' },
    simple_realidad: { title:'¿Independiente o empleado disfrazado?', text:'Si facturas como independiente pero en la práctica le trabajas a <strong>una sola empresa</strong>, cumpliendo horario y recibiendo órdenes como un empleado, la ley te considera empleado y no te deja usar el Simple. Si tienes varios clientes y manejas tu tiempo, no es tu caso.' },
    simple_aldia: { title:'Estar al día', text:'Para entrar al Simple no puedes tener <strong>deudas vencidas</strong> de impuestos con la DIAN ni de tus aportes a salud y pensión. Si estás al día, cumples este requisito.' },
    simple_factura: { title:'RUT y factura electrónica', text:'Para estar en el Simple necesitas estar inscrito en el <strong>RUT</strong> (tu registro ante la DIAN) y emitir <strong>factura electrónica</strong>. Si aún no los tienes, puedes sacarlos antes de inscribirte; no es un impedimento definitivo.' },
    simple_socio: { title:'Socio de otras empresas', text:'Si eres socio o dueño de otras empresas, tus ingresos <strong>se suman</strong> con los de ellas para revisar el límite del Simple, y en algunos casos eso te deja por fuera. Conviene revisarlo con calma.' },
    sas_costos_negocio: { title:'Costos de tu negocio', text:'Son los gastos reales para producir tus ingresos (materiales, arriendo del local, empleados, etc.). La empresa los descuenta antes de calcular el impuesto. Si prestas servicios y casi no tienes gastos, déjalo en cero.' },
    her_vivienda: { title:'Vivienda del causante', text:'La casa o apartamento donde <strong>vivía</strong> la persona fallecida. La ley exonera las primeras 13.000 UVT (~$680 millones) de su valor. Escribe la parte que te corresponde a ti. Ese beneficio se reparte entre los herederos que reciben la vivienda.' },
    her_otros_inm: { title:'Otros inmuebles', text:'Inmuebles distintos a la vivienda donde vivía la persona fallecida (locales, lotes, apartamentos de renta, etc.). La ley exonera las primeras 6.500 UVT (~$340 millones), repartidas entre los herederos que los reciben. No incluye fincas de recreo.' },
    her_otros_bienes: { title:'Otros bienes', text:'Dinero, vehículos, inversiones, acciones y demás bienes que recibes de la herencia. No tienen una exención propia por tipo de bien, pero sí entran en tu exención personal.' },
    her_seguro: { title:'Seguro de vida', text:'Si eres beneficiario de un seguro de vida de la persona fallecida, lo que recibas está exento hasta 3.250 UVT (~$170 millones); solo el excedente paga el 15% (art. 303-1). Es una exención aparte de las de la herencia.' },
    her_herederos: { title:'Número de herederos', text:'Entre cuántas personas se reparten los inmuebles de la herencia. Las exenciones de la vivienda (13.000 UVT) y de otros inmuebles (6.500 UVT) se dividen entre ellos. Si eres el único, deja 1.' },
    her_legitimario: { title:'¿Eres familiar directo?', text:'Los <strong>hijos, el cónyuge y los padres</strong> (legitimarios y cónyuge) tienen una exención personal de 3.250 UVT (~$170 millones) sobre lo que reciben. Otras personas (sobrinos, amigos, etc.) tienen en cambio una exención del 20%, con tope de 1.625 UVT.' },
    pat_vivienda: { title:'Vivienda de habitación', text:'El valor de la casa o apartamento donde vives la mayor parte del tiempo. Para el impuesto al patrimonio puedes restar de la base las primeras 12.000 UVT (~$628 millones) de ese inmueble. Solo aplica a tu vivienda principal, no a fincas de recreo ni segundas viviendas. Usa el valor patrimonial (avalúo o costo fiscal) que declaras.' },
    pat_deudas: { title:'¿Qué deudas puedo restar?', text:'Solo las deudas reales, vigentes y con soporte. Un crédito bancario se prueba con el extracto y se acepta sin problema. Pero un préstamo con un particular o un familiar solo lo acepta la DIAN si está documentado con <strong>fecha cierta</strong> (un pagaré o contrato autenticado ante notario) o si la persona que te prestó declara esa cuenta por cobrar en su propia renta. Si es una deuda familiar informal sin soporte, la DIAN puede rechazarla: eso sube tu patrimonio gravable y, en el peor caso, el préstamo se trata como una donación que paga ganancia ocasional. Consérvalo documentado.' },
    sas_costos_sas: { title:'Costo de tener la SAS', text:'Mantener una empresa cuesta al año: el <strong>contador</strong> (lo más caro), la renovación en la cámara de comercio, la factura electrónica y la firma digital. Pusimos un estimado de $6.000.000; ajústalo si conoces tus valores. No incluye revisor fiscal, que solo se necesita con ingresos muy altos.' },
    sas_salario: { title:'El sueldo que te pagas', text:'Dentro de tu empresa puedes contratarte y pagarte un sueldo. La empresa lo <strong>descuenta</strong> (baja su utilidad y el impuesto del 35%), pero tú lo declaras como tu <strong>ingreso personal</strong>: sobre él calculamos automáticamente tus aportes a salud y pensión y tu impuesto de renta, usando <strong>tus mismas deducciones</strong> (dependientes, vivienda, etc.). La estrategia: repartir cuánto sacas como sueldo y cuánto dejas como utilidad de la empresa. Prueba distintos montos y observa el total.' },
    sas_dividendos: { title:'Dividendos (sacar la utilidad de la empresa)', text:'La utilidad que queda en la empresa (después del sueldo, los costos y su impuesto del 35%) es de la empresa. Para llevártela a tu bolsillo, la repartes como <strong>dividendos</strong>: en <strong>100%</strong> te la pasas toda (pagas 15% sobre lo que exceda ~$57 millones al año); en <strong>0%</strong> la dejas invertida en la empresa y no pagas ese impuesto todavía.' },
    costo_heredado: { title:'Costo fiscal de un bien heredado', text:'Un bien heredado o donado no tuvo precio de compra. Su costo fiscal es el <strong>valor de adjudicación en la sucesión</strong> —para inmuebles, el valor patrimonial según el art. 303/277, que suele ser el avalúo catastral—. Si es bien raíz o acciones, ese valor se puede ajustar por el art. 73 tomando como año de adquisición el de la sucesión. Recibir la herencia ya fue una ganancia ocasional aparte; esto es para cuando <strong>vendas</strong> el bien.' },
    fiscal_exterior: { title:'Activos en el exterior', text:'Cuentas, inversiones o propiedades fuera de Colombia. Si su valor supera 2.000 UVT debes presentar una declaración anual especial. No reportarlos tiene sanciones altas.' },
    fiscal_digitos: { title:'Dígitos del documento', text:'La DIAN asigna la fecha exacta de tus declaraciones según los <strong>dos últimos dígitos</strong> de tu cédula (renta) o de tu NIT (IVA, exógena). Con ellos podemos darte el día exacto, no solo el mes.' },
    fondo_estabilizacion: {
      title: 'Fondo de estabilización',
      text: 'Cuenta separada que suaviza los meses bajos de un ingreso variable para que puedas pagarte un salario estable. <strong>Distinto al fondo de emergencia</strong>: este amortigua la fluctuación normal mes a mes; la pérdida de un contrato la cubre el fondo de emergencia (meta aparte). Su tamaño se calcula con tu variabilidad real (≈ 1,65 × desviación estándar × √6): pequeño si tu ingreso es estable, grande si es volátil.'
    },
    fondo_provisiones: {
      title: 'Fondo de provisiones',
      text: 'Cuenta donde apartas mes a mes el dinero para gastos anuales conocidos (matrícula, predial, póliza de auto, primas de seguros). <strong>No es ahorro</strong> — es dinero asignado a un futuro pago. Cuando llega el mes del gasto, la plata ya está y evitas endeudarte.'
    },
    fondo_emergencias: {
      title: 'Fondo de emergencias',
      text: 'Reserva para eventos <strong>imprevistos y urgentes</strong>: una enfermedad, una reparación mayor, perder el ingreso. Meta: 6 meses de gastos. No se toca para nada planeable. Para gastos planeables existe el fondo de provisiones.'
    },
    ingreso_base_seguro: {
      title: 'Ingreso base seguro',
      text: 'Es el percentil 25 de tus ingresos netos históricos: el nivel que <strong>3 de cada 4 meses superan</strong>. Sirve de base para fijar tu salario personal porque es lo que tu negocio sostiene la mayor parte del tiempo, sin contar los meses excepcionalmente buenos.'
    },
    variabilidad: {
      title: 'Variabilidad de tu ingreso',
      text: 'Cuánto cambia tu ingreso mes a mes en promedio. Bajo 25 % es estable, entre 25 % y 50 % es variable, sobre 50 % es muy volátil. A más variabilidad, más grande debe ser tu fondo de estabilización.'
    },
    reserva_tributaria: {
      title: 'Reserva tributaria',
      text: 'Porcentaje de cada ingreso bruto que apartas para impuestos (renta, retenciones, IVA si aplica). Para independientes en régimen ordinario en Colombia, suele ser entre 10 % y 15 %. Si no apartas, en abril te toca pagar con deuda.'
    },
    apalancamiento: {
      title: 'Deuda de apalancamiento',
      text: 'Deuda que <strong>genera un activo o ingreso</strong>: hipotecaria, crédito de inversión, préstamo para un negocio. Es deuda "que trabaja". Lo opuesto es la deuda de consumo (tarjeta, libranza), que solo financia gasto y reduce tu capacidad económica.'
    },
    activo_liquido: {
      title: 'Activo líquido',
      text: 'Lo que puedes convertir en dinero rápido y sin perder valor: cuenta de ahorros, fondos de inversión líquidos, CDTs cortos. Lo no líquido (casa, carro, fondos de pensión) tiene valor pero no lo puedes usar inmediatamente.'
    },
    salario_personal: {
      title: 'Salario personal',
      text: 'Monto fijo que un independiente se paga a sí mismo cada mes, sin importar lo que haya facturado. <strong>Convierte un ingreso volátil en uno predecible</strong>. Cuando ganas más, el excedente va al fondo. Cuando ganas menos, el fondo cubre la diferencia.'
    },
    indice_prevision: {
      title: 'Índice de previsión',
      text: 'Porcentaje de los gastos anuales próximos a vencer que ya tienes provisionados. <strong>100 % significa que no necesitas endeudarte</strong> para cumplirlos. Es la mejor medida de qué tan organizada está tu vida financiera.'
    },
    costo_vida_real: {
      title: 'Costo de vida real',
      text: 'Tus gastos mensuales más el equivalente mensual de los gastos anuales (matrícula, predial, primas, etc., divididos en 12). Es lo que <strong>realmente</strong> te cuesta vivir cada mes, no solo lo que paga la tarjeta debit este mes.'
    },

    /* ── Módulo 13 · Estructura Legal Patrimonial ── */
    leg_estado_civil: {
      title:'Estado civil',
      text:'Tu situación de pareja según el registro civil. Lo importante para el patrimonio es si vives con alguien: <strong>casado</strong> genera automáticamente un régimen donde comparten bienes al 50%, y la <strong>unión libre de más de 2 años</strong> también los comparte por ley (aunque hay que declararlo en notaría). Los <strong>solteros, viudos y divorciados</strong> con sociedad ya liquidada manejan sus bienes de forma individual.'
    },
    leg_regimen_conyugal: {
      title:'¿Cómo manejan los bienes en el matrimonio?',
      text:'Cuando te casaste, sin que firmaras nada especial, entraste automáticamente al régimen normal en Colombia: todo lo que compres durante el matrimonio (con excepción de herencias y regalos) es de los dos al 50%, aunque esté a nombre de uno solo. La única forma de mantener los bienes separados es firmar un acuerdo llamado <strong>capitulaciones</strong> ante notaría (antes o durante el matrimonio). Si no lo firmaste, todo es compartido.'
    },
    leg_capitulaciones: {
      title:'Capitulaciones',
      text:'Un acuerdo que firman los cónyuges ante notaría para mantener sus bienes separados durante el matrimonio, en vez del régimen normal donde todo lo adquirido se comparte al 50%. Se puede hacer antes de casarse o después. Ojo: solo aplica a partir de la fecha en que se firmen, no cambia el estado de los bienes que ya tenían antes. Costo aproximado: $300.000 a $800.000 en notaría.'
    },
    leg_union_marital: {
      title:'Unión libre (unión marital de hecho)',
      text:'Convivir de forma permanente y estable con una pareja sin estar casados. La ley colombiana reconoce que después de <strong>2 años de convivencia</strong> ustedes forman una "sociedad patrimonial": los bienes que compren en ese tiempo son de los dos, aunque estén a nombre de uno solo. Para que quede oficial y no toque probarlo en juzgado más adelante, conviene declararlo en notaría de común acuerdo. Base legal: Ley 54 de 1990.'
    },
    leg_testamento: {
      title:'Testamento',
      text:'Un documento donde dejas por escrito cómo quieres que se repartan tus bienes cuando faltes. Hay tres tipos, pero el más común y práctico es el <strong>abierto</strong>, que se hace en notaría en una sola visita. Sirve principalmente para: dejar bienes específicos a personas específicas (ej. la casa de la playa para un hijo particular), nombrar quién administra tu herencia mientras se resuelve, designar tutores si tienes hijos menores, y planificar qué pasa con tu negocio. Importante: no puedes desheredar completamente a tus hijos, padres o cónyuge — la ley les garantiza mínimo el 50% del total, ese es su derecho protegido.'
    },
    leg_testamento_tipo: {
      title:'Tipos de testamento',
      text:'<strong>Abierto</strong>: es el estándar. Le dices al notario cómo quieres repartir tus bienes, él lo escribe y lo firma con 2 testigos. Queda archivado en la notaría. <strong>Cerrado</strong>: lo escribes tú en privado, lo metes en un sobre sellado y lo entregas al notario; se abre cuando faltas. <strong>Ológrafo</strong>: escrito completamente a mano por ti, casi no se usa en Colombia. Si no estás seguro cuál tienes, casi siempre es el abierto.'
    },
    leg_beneficiarios: {
      title:'¿A quién le paga el seguro?',
      text:'Cuando contrates un seguro de vida, tienes dos opciones para decir quién recibe el dinero si tú faltas: (1) <strong>beneficiarios específicos</strong>: escoges tú a las personas y los porcentajes (por ejemplo: 60% para mi esposa, 40% para mi hijo). El pago llega directo a ellos en pocas semanas, no se pelea entre herederos y no responde por tus deudas. (2) <strong>Beneficiarios "de ley"</strong>: no escoges tú, sino que el dinero entra a la herencia general y se reparte con todo lo demás, lo que puede tomar meses y generar disputas. Cambiar quién recibe el dinero es gratis, se hace directamente con la aseguradora.'
    },
    leg_avales: {
      title:'¿Qué es un aval?',
      text:'Cuando firmas garantizando la deuda de otra persona o empresa. Es muy común: firmas como aval de un familiar en un préstamo, o de tu empresa cuando pide crédito. El riesgo: si esa persona o empresa deja de pagar, el banco te cobra <strong>directamente a ti todo el saldo</strong>, con tus bienes personales, sin tener que agotar primero al deudor principal. En pagarés, letras y la mayoría de préstamos personales así funciona (se llama "aval mercantil"). Revisa siempre qué firmaste.'
    },
    leg_pleitos: {
      title:'Procesos judiciales en tu contra',
      text:'Cualquier demanda donde eres la parte demandada: laboral (un ex-empleado te demanda), civil (un contrato que salió mal), comercial, penal con reclamo económico, o administrativa. Mientras el proceso esté abierto, el juez puede ordenar embargos sobre tus bienes como medida preventiva. Y ojo con algo importante: si en medio de un pleito activo intentas "esconder" bienes traspasándolos a familiares o vendiéndolos a precio bajo, el juez puede anular esas operaciones porque la ley las considera fraude a los acreedores.'
    },
    leg_formulario_160: {
      title:'Formulario 160 · Activos en el exterior',
      text:'Una declaración anual que le presentas a la DIAN si tienes bienes fuera de Colombia (cuentas bancarias, inversiones, apartamentos, empresas) por más de <strong>2.000 UVT</strong> (unos $104,7 millones en 2026). Es diferente y separada de tu declaración de renta normal. Se hace en el portal de la DIAN, en línea. Para <strong>personas naturales</strong> los plazos van del 12 de agosto al 26 de octubre de 2026, dependiendo de los dos últimos dígitos de tu cédula. Si no la presentas o la haces tarde, la sanción es del 0,5% del valor de esos activos por cada mes de atraso (tope 10%). Y importante: la DIAN recibe información de tus cuentas fuera del país automáticamente por convenios internacionales.'
    },
    leg_ece: {
      title:'Ser dueño de una empresa fuera de Colombia',
      text:'Si vives en Colombia pero eres dueño mayoritario (más del 50%) de una empresa en el exterior, la ley te obliga a algo especial: las ganancias "pasivas" de esa empresa (intereses de inversiones, dividendos que recibe, arriendos, regalías, ganancias por venta de acciones) se consideran <strong>tuyas directamente</strong> en Colombia el mismo año en que la empresa las obtiene, aunque no te hayan pagado ni un peso. Las ganancias de la operación normal del negocio (vender productos o servicios) no aplican a esta regla. Base legal: arts. 882 a 893 del Estatuto Tributario. Esto no es opcional y tiene sanciones fuertes si no se declara.'
    },
    leg_legitimarios: {
      title:'Herederos con derecho protegido',
      text:'La ley colombiana protege a ciertos familiares y les garantiza mínimo el 50% de tu herencia, no puedes desheredarlos: son tus <strong>hijos</strong> (o los nietos si un hijo faltó antes), tus <strong>padres</strong> (solo si no tienes hijos) y tu <strong>cónyuge</strong>. Ese 50% obligatorio se llama "legítima". El otro 50% sí lo puedes repartir libremente: 25% para dar más a algún hijo específico, y 25% para quien tú quieras (una amiga, una fundación, alguien fuera de la familia). Sin testamento, todo se reparte por reglas fijas: primero los hijos por partes iguales, luego padres/cónyuge, luego hermanos.'
    },
    leg_velo_corporativo: {
      title:'¿Por qué una SAS te protege?',
      text:'Cuando tu negocio está en una SAS (o cualquier sociedad), la ley dice que tú como socio solo respondes por las deudas del negocio hasta el monto que aportaste. Si al negocio le va mal, los acreedores no pueden ir contra tu casa, carro o cuentas personales. La <strong>excepción</strong>: si usas la sociedad para hacer trampa (por ejemplo, sacar plata de forma indebida o esconder bienes), un juez puede "levantar el velo" y hacerte responder con tu patrimonio personal. Esto casi nunca pasa en la operación normal — solo en casos claros de fraude.'
    },
    leg_holding: {
      title:'¿Qué es un holding?',
      text:'Una empresa cuyo único trabajo es ser dueña de las acciones de otras empresas, no operar directamente. Se usa cuando ya tienes patrimonio grande porque: (1) los dividendos que le paga tu empresa operativa al holding no vuelven a pagar impuesto de renta; (2) heredar se vuelve más simple porque tus herederos reciben "acciones del holding" en vez de una lista larga de bienes; (3) si tu empresa operativa tiene problemas, tus otros bienes (que están bajo el holding) quedan protegidos. Requiere análisis previo con contador y abogado.'
    },
    leg_fideicomiso: {
      title:'Fideicomiso: administración profesional de bienes',
      text:'Un contrato donde entregas ciertos bienes a una empresa fiduciaria (Alianza, Fiduagraria, Skandia, etc.) para que los administre según reglas que tú defines. Ejemplos de uso: para que administren la herencia de tus hijos si eres empresario y ellos son menores; para asegurar que un familiar con problemas de manejo del dinero reciba una mensualidad y no gaste todo de una; para separar bienes del patrimonio personal por protección. Los bienes en fideicomiso no responden por tus deudas personales.'
    },
    leg_rc_profesional: {
      title:'Póliza de Responsabilidad Civil Profesional',
      text:'Un seguro que te cubre si un cliente te demanda por un error en tu trabajo profesional: un médico por mala praxis, un ingeniero por un diseño con fallas, un contador por un dictamen errado, un abogado por asesoría deficiente. La aseguradora paga tu <strong>defensa jurídica</strong> (que puede ser costosa incluso si ganas el caso) y las <strong>condenas</strong> hasta el monto asegurado. Importante entender: aunque tengas tu negocio en una SAS, la responsabilidad profesional te persigue a ti como persona natural — la SAS no te protege de esto. La cotizan Sura, Bolívar, Liberty, Chubb, entre otras. Muchos gremios (colegios de médicos, contadores, arquitectos) tienen convenios que dan tarifas preferenciales.'
    },
    leg_dyo: {
      title:'Póliza D&O (Directores y Administradores)',
      text:'Un seguro que protege a los administradores de una empresa (representante legal, socio y RL, miembros de junta directiva, gerentes con poder de decisión) frente a demandas por decisiones tomadas en su rol. La ley colombiana (Ley 222 de 1995, arts. 22 a 25) establece que los administradores responden con su patrimonio personal por daños causados con culpa o dolo — a la sociedad, a los socios o a terceros. Ejemplos donde D&O es útil: demandas de socios minoritarios por decisiones que consideran perjudiciales, demandas de la DIAN por incumplimientos tributarios de la empresa, demandas laborales que buscan responsabilidad solidaria del representante legal, procesos por competencia desleal. La póliza paga la defensa jurídica y las condenas. Puede contratarla la empresa (más común) o el administrador personalmente.'
    },
    leg_gasto_familia: {
      title:'Gasto mensual familiar en caso de fallecimiento',
      text:'La cifra base para calcular cuánto tiempo aguantarían tus recursos líquidos si tú faltas, y qué tamaño de seguro de vida sería adecuado. Incluye: <strong>vivienda</strong> (arriendo o cuota de hipoteca, servicios, administración), <strong>alimentación y necesidades básicas</strong>, <strong>educación</strong> (colegio, universidad, actividades), <strong>salud</strong> (medicina prepagada, medicamentos, terapias), <strong>transporte</strong>, y un margen para <strong>otros gastos e imprevistos</strong>. Si estás casado o en unión libre, considera solo lo que aportaría tu ingreso — no lo que aporta tu pareja. La cifra típica de una familia de clase media en Colombia oscila entre $6M y $20M mensuales según ciudad, tamaño y estilo de vida.'
    }
  };
  
  /* Crea HTML de un info-tip dado un key de DEFINITIONS */
  function tip(defKey){
    if(!DEFINITIONS[defKey]) return '';
    return '<span class="info-tip" data-def="' + defKey + '" tabindex="0">i</span>';
  }
  
  /* Sistema global de popover */
  let activeTipPopover = null;
  function showTipPopover(triggerEl, defKey){
    closeTipPopover();
    const def = DEFINITIONS[defKey];
    if(!def) return;
    const pop = document.createElement('div');
    pop.className = 'info-tip-popover';
    pop.innerHTML = '<span class="tip-title">' + def.title + '</span>' + def.text;
    document.body.appendChild(pop);
  
    const rect = triggerEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 10;
  
    // Posicionar: preferir debajo, si no cabe, arriba
    let top = rect.bottom + margin;
    let placement = 'below';
    if(top + popRect.height > window.innerHeight - 20){
      top = rect.top - popRect.height - margin;
      placement = 'above';
    }
    let left = rect.left + rect.width/2 - popRect.width/2;
    // Mantener dentro de la pantalla
    if(left < 12) left = 12;
    if(left + popRect.width > window.innerWidth - 12) left = window.innerWidth - popRect.width - 12;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.classList.add(placement);
    setTimeout(()=>pop.classList.add('show'), 10);
  
    activeTipPopover = pop;
    triggerEl.classList.add('open');
  
    // Cerrar al hacer click fuera
    setTimeout(()=>{
      document.addEventListener('click', closeTipPopoverOnClickOutside, {once:true});
    }, 50);
  }
  function closeTipPopover(){
    if(activeTipPopover){
      activeTipPopover.remove();
      activeTipPopover = null;
    }
    document.querySelectorAll('.info-tip.open').forEach(el=>el.classList.remove('open'));
  }
  function closeTipPopoverOnClickOutside(e){
    if(e.target.closest('.info-tip-popover')) return;
    if(e.target.closest('.info-tip')) return;
    closeTipPopover();
  }
  
  /* Delegación global de clicks en cualquier .info-tip */
  document.addEventListener('click', function(e){
    const tip = e.target.closest('.info-tip');
    if(!tip) return;
    e.stopPropagation();
    if(tip.classList.contains('open')){
      closeTipPopover();
    } else {
      showTipPopover(tip, tip.dataset.def);
    }
  });
  window.addEventListener('resize', closeTipPopover);
  window.addEventListener('scroll', closeTipPopover, true);
  /* ═══════════════════════════════════════════════════════════
     MÓDULO 9 — INFORME PDF PARA EL ASESOR
     Todo se calcula DESDE EL ESTADO (no del DOM), para que el
     informe sea correcto sin importar en qué módulo esté el usuario.
     ═══════════════════════════════════════════════════════════ */
  function debtTypeLabel(tipo){ const dt = DEBT_TYPES.find(d=>d.val===tipo); return dt ? dt.label : 'Otra'; }
  function metaFuenteLabel(f){
    f = f || 'manual';
    if(f==='manual') return 'Manual';
    if(f==='liquido_total') return 'Activos líquidos';
    if(f==='fondo_provisiones') return 'Fondo de provisiones';
    if(f==='fondo_estabilizacion') return 'Fondo de estabilización';
    if(f.indexOf('activo:')===0) return 'Activo · ' + f.slice(7);
    return 'Manual';
  }
  function reportClientName(){
    const ov = (state.tablero.informeNombre||'').trim();
    if(ov) return ov;
    const s1=(state.p5.socio1||'').trim(), s2=(state.p5.socio2||'').trim();
    if(s1 && s2) return s1 + ' y ' + s2;
    return s1 || s2 || 'Cliente';
  }

  function buildReportData(){
    const montoAh = a => (a.monto_mensual!=null ? a.monto_mensual : a.monto) || 0;
    // ── Ingresos ──
    const ingresosFilas = (state.ingresos||[])
      .filter(i => (i.monto||0)!==0 || (i.nombre||'').trim())
      .map(i => ({nombre:i.nombre||'Ingreso', monto:i.monto||0}));
    const ingresoMensual = (state.ingresos||[]).reduce((s,i)=>s+(i.monto||0),0);
    // ── Ingresos variables (detalle: histórico, retenciones, gastos asociados) ──
    let varDetalle = null;
    if(state.varIncome && state.varIncome.active){
      const contratosD = (state.varIncome.contratos||[]).map(c=>{
        const meses = (c.meses||[]).map(m=>{
          recalcMesNetoC(c, m);
          return { label: mesLabelFmt(m), bruto:m.bruto||0, costos:m.costos||0,
                   tributo:(c.retencionAplica?Math.max(0,m.tributo||0):0), neto:m.neto||0 };
        });
        return { nombre:c.nombre||'Contrato', tipo:c.tipo||'—',
                 retencion: c.retencionAplica ? ('Sí · '+(c.retencionPct||0)+'%') : 'No',
                 meses };
      });
      const comb = getCombinedMeses();
      varDetalle = {
        contratos: contratosD,
        combinado: comb.map(m=>({label:m.label, bruto:m.bruto||0, costos:m.costos||0, tributo:m.tributo||0, neto:m.neto||0})),
        totales: {
          bruto: comb.reduce((s,m)=>s+(m.bruto||0),0), costos: comb.reduce((s,m)=>s+(m.costos||0),0),
          tributo: comb.reduce((s,m)=>s+(m.tributo||0),0), neto: comb.reduce((s,m)=>s+(m.neto||0),0)
        },
        salarioSostenible: (typeof getSalarioPersonalActual==='function' ? getSalarioPersonalActual() : (state.varIncome.salarioPersonal||0)),
        fondoActual: state.varIncome.fondoActual||0,
        fondoMeta: (typeof getFondoMetaActual==='function' ? getFondoMetaActual() : 0)
      };
    }
    // ── Gastos ──
    const gastosFilas=[]; const gastosDetalle=[]; let totalNec=0, totalDes=0, totalGastos=0;
    const orden = (state.gastosOrder && state.gastosOrder.length) ? state.gastosOrder : Object.keys(state.gastos||{});
    orden.forEach(cat=>{
      if(!(cat in (state.gastos||{}))) return;
      const val = state.gastos[cat]||0;
      const b = gastoBucket(cat);
      const bLabel = b==='nec'?'Necesidad':b==='aho'?'Ahorro':'Deseo';
      gastosFilas.push({cat:gastoLabel(cat), bucket:bLabel, monto:val});
      totalGastos += val;
      if(b==='nec') totalNec+=val; else if(b!=='aho') totalDes+=val;
      // Detalle por ítem dentro de la categoría
      const items = Array.isArray(state.gastosItems && state.gastosItems[cat]) ? state.gastosItems[cat] : null;
      if(items && items.length){
        items.forEach(it=>{
          gastosDetalle.push({cat:gastoLabel(cat), concepto:(it.nombre||'').trim()||'(sin nombre)', bucket:bLabel, monto:it.monto||0});
        });
      } else if(val>0){
        gastosDetalle.push({cat:gastoLabel(cat), concepto:'(total de la categoría)', bucket:bLabel, monto:val});
      }
    });
    const anualesGastos=[];
    Object.values(state.p5.gastos||{}).forEach(rows=>{
      (rows||[]).forEach(r=>{
        if(r.frec==='NO ES TODOS LOS MESES' && (r.monto||0)>0){
          const mn = parseInt(r.mes);
          const mesLbl = (mn>=1 && mn<=12) ? MES_NAMES_FULL[mn-1] : 'Sin mes';
          anualesGastos.push({concepto:r.nombre||'Gasto anual', mes:mesLbl, monto:r.monto||0});
        }
      });
    });
    // ── Deudas ──
    const deudasFilas=[]; let totalDeuda=0, servicioDeuda=0, totConsumo=0, totApal=0, pagosConsumo=0, sumaPond=0;
    const soloIntereses=[];
    (state.deudas||[]).forEach(d=>{
      const saldo=d.saldo||0, cuota=d.cuota_mensual||0, tasa=d.tasa_anual||0;
      const grupo = d.grupo || debtGroup(d.tipo||'');
      totalDeuda+=saldo; servicioDeuda+=cuota; sumaPond+=saldo*tasa;
      if(grupo==='consumo'){ totConsumo+=saldo; pagosConsumo+=cuota; } else if(grupo==='apalancamiento'){ totApal+=saldo; }
      const em = eaToMonthly(tasa);
      const si = saldo>0.5 && cuota>0 && cuota <= saldo*em*1.001;
      if(si) soloIntereses.push(d.nombre||'Deuda');
      deudasFilas.push({nombre:d.nombre||'Deuda', tipo:debtTypeLabel(d.tipo), saldo, tasa, cuota, soloIntereses:si});
    });
    const tasaProm = totalDeuda>0 ? sumaPond/totalDeuda : 0;
    const ratioConsumo = totalDeuda>0 ? totConsumo/totalDeuda : 0;
    const ratioApal = totalDeuda>0 ? totApal/totalDeuda : 0;
    const pctConsumoIng = ingresoMensual>0 ? pagosConsumo/ingresoMensual : 0;
    // ── Activos (tabla enriquecida: lee del Mapa Patrimonial normalizado) ──
    const activosFilas=[]; let totalLiquido=0, totalNoLiquido=0;
    let mapaRD = null;
    try { mapaRD = (window.MapaPatrimonial && window.MapaPatrimonial.getData) ? window.MapaPatrimonial.getData() : null; } catch(e){ mapaRD=null; }
    const activosNorm = (mapaRD && Array.isArray(mapaRD.activosNormalizados)) ? mapaRD.activosNormalizados : [];
    const estructuraLabel = (e)=>({
      'Propiedad Directa':'A tu nombre','Sociedad Comercial':'Sociedad (SAS/Ltda/S.A.)','LLC':'LLC exterior',
      'Holding':'Holding familiar','Fideicomiso':'Fideicomiso','Otro':'Otra figura'
    }[e] || (e||'A tu nombre'));
    activosNorm.forEach(a=>{
      const v=a.valor||0;
      if(a.tipo==='LÍQUIDO') totalLiquido+=v; else totalNoLiquido+=v;
      activosFilas.push({
        nombre: a.nombre||'Activo',
        subtipo: a._subtipo || a._categoria || '—',
        categoria: a._categoria || '—',
        valor: v,
        participacion: (a._esCompartido && a._porcentajePropio < 100) ? a._porcentajePropio : 100,
        estructura: estructuraLabel(a._estructuraLegal),
        liquidez: a._liquidez || (a.tipo==='LÍQUIDO'?'Alta':'Ilíquida'),
        moneda: a._moneda || 'COP',
        pais: a._pais || 'Colombia',
        sector: a._sector || '—',
        renta: a._ingresoMensual || 0,
        deuda: a._deudaCOP || 0,
        neto: a._netoCOP != null ? a._netoCOP : v,
        reparto: a._reparto === 'muchas' ? 'Repartida' : (a._reparto === 'una' ? 'Una sola' : ''),
        beneficioTrib: !!a._beneficioTributario,
        restringido: !!a.restringido
      });
    });
    // Compatibilidad: si el Mapa no está disponible, caer a state.activos (versión simple).
    if(!activosNorm.length){
      (state.activos||[]).forEach(a=>{
        const v=a.valor||0;
        if(a.tipo==='LÍQUIDO') totalLiquido+=v; else totalNoLiquido+=v;
        activosFilas.push({nombre:a.nombre||'Activo', subtipo:'—', categoria:'—', valor:v, participacion:100,
          estructura:'—', liquidez:a.tipo==='LÍQUIDO'?'Alta':'Ilíquida', moneda:'COP', pais:'Colombia', sector:'—',
          renta:0, deuda:0, neto:v, reparto:'', beneficioTrib:false, restringido:!!a.restringido});
      });
    }
    const totalRentaMensual = activosFilas.reduce((s,a)=>s+(a.renta||0),0);
    const totalActivos = totalLiquido+totalNoLiquido;
    const patrimonio = totalActivos - totalDeuda;
    const solvencia = totalDeuda>0 ? totalActivos/totalDeuda : 0;
    const pctLiquidos = totalActivos>0 ? totalLiquido/totalActivos : 0;
    // ── Ahorro ──
    const ahorroArr = state.ahorro||[];
    const totalAhorro = ahorroArr.reduce((s,a)=>s+montoAh(a),0);
    const esPrec = a => a.linkedToFondoAporte||a.linkedToProvisionesAporte||a.precaucion;
    const ahorroPrec = ahorroArr.filter(esPrec).reduce((s,a)=>s+montoAh(a),0);
    const ahorroInv = totalAhorro - ahorroPrec;
    const capacidadPct = ingresoMensual>0 ? ahorroInv/ingresoMensual : 0;
    const fondoEmergMeses = totalGastos>0 ? totalLiquido/totalGastos : 0;
    const fondoEstab = (state.varIncome && state.varIncome.fondoActual) || 0;
    const provisiones = state.p5.fondoProvisiones || 0;
    // ── 50/30/20 (réplica de renderBudgetRuleResult) ──
    const ingresoRegla = ingresoMensual + (state.p5.ingAnual||0)/12;
    const provisionAporte = ahorroArr.filter(a=>a.linkedToProvisionesAporte).reduce((s,a)=>s+montoAh(a),0);
    let nec = servicioDeuda, des = 0, aho = totalAhorro - provisionAporte;
    Object.entries(state.gastos||{}).forEach(([cat,val])=>{ const b=gastoBucket(cat); if(b==='nec')nec+=(val||0); else if(b==='aho')aho+=(val||0); else des+=(val||0); });
    Object.values(state.p5.gastos||{}).forEach(rows=>{ (rows||[]).forEach(r=>{ if(r.frec!=='NO ES TODOS LOS MESES')return; if(r.yaEnM1)return; const m=(r.monto||0)/12; if(m<=0)return; if(r.bucket==='des')des+=m; else nec+=m; }); });
    const pdPlan = state.tablero.planDeuda||{};
    const abonoExtraMensual = (pdPlan.activo && pdPlan.extraMensual>0) ? pdPlan.extraMensual : 0;
    aho += abonoExtraMensual;
    const tg = ruleTargets();
    const brRule = state.tablero.budgetRule || {};
    const reglaNombre = (brRule.rule==='custom')
      ? ('Personalizada (' + (brRule.custom&&brRule.custom.nec||0) + '/' + (brRule.custom&&brRule.custom.des||0) + '/' + (brRule.custom&&brRule.custom.aho||0) + ')')
      : (brRule.rule || '50/30/20');
    function reglaFila(cubeta, real, metaPct, tipo){
      const metaAmt = ingresoRegla * metaPct / 100;
      const dif = real - metaAmt; // + = por encima del monto meta
      let estado, detalle;
      if(tipo==='piso'){ // ahorro: cumplir es estar por encima
        if(real >= metaAmt){ estado='ok'; detalle = fmt(Math.abs(dif)) + ' por encima de la meta'; }
        else { estado='falta'; detalle = fmt(Math.abs(dif)) + ' por debajo de la meta'; }
      } else { // necesidades/deseos: cumplir es estar por debajo (techo)
        if(real <= metaAmt){ estado='ok'; detalle = fmt(Math.abs(dif)) + ' de margen bajo la meta'; }
        else { estado='excede'; detalle = fmt(Math.abs(dif)) + ' por encima de la meta'; }
      }
      return {cubeta, real, pct: ingresoRegla>0?real/ingresoRegla:0, meta:metaPct, metaAmt, dif, estado, detalle, tipo};
    }
    const reglaRows = [
      reglaFila('Necesidades', nec, +tg.nec||0, 'techo'),
      reglaFila('Deseos', des, +tg.des||0, 'techo'),
      reglaFila('Ahorro/inversión', aho, +tg.aho||0, 'piso')
    ];
    const reglaOk = (nec <= ingresoRegla*(+tg.nec||50)/100) && (des <= ingresoRegla*(+tg.des||30)/100) && (aho >= ingresoRegla*(+tg.aho||20)/100);
    // ── Uso mensual ──
    const pagosConExtra = servicioDeuda + abonoExtraMensual;
    const usoRows = [
      {concepto:'Ingresos mensuales', valor:ingresoMensual, pct:1},
      {concepto:'Ahorro mensual', valor:totalAhorro, pct: ingresoMensual>0?totalAhorro/ingresoMensual:0},
      {concepto:'Pago a deudas', valor:pagosConExtra, pct: ingresoMensual>0?pagosConExtra/ingresoMensual:0},
      {concepto:'Gastos mensuales', valor:totalGastos, pct: ingresoMensual>0?totalGastos/ingresoMensual:0}
    ];
    const anual = {
      ing: state.p5.ingAnual||0, aho: state.p5.ahoAnual||0, deu: state.p5.deuAnual||0,
      gas: state.p5.gastosAnual||0, saldo: state.p5.saldo||0,
      abono: (pdPlan.activo && pdPlan.abono && pdPlan.abono.monto>0) ? pdPlan.abono : null,
      abonoMensual: abonoExtraMensual
    };
    const superavit = ingresoMensual - totalGastos - servicioDeuda - totalAhorro;
    // ── Plan de deudas ──
    const plan = computeDebtPlanSummary();
    // ── Metas ──
    const metas = (state.metas.items||[]).filter(m=>(m.nombre||'').trim()||m.objetivo>0).map(m=>{
      const saldo = metaSaldoActual(m);
      return {nombre:m.nombre||'Meta', objetivo:m.objetivo||0, saldo, aporte:m.aporte||0, fecha:m.fecha||'—', fuente:metaFuenteLabel(m.fuente), avance:(m.objetivo>0)?Math.min(saldo/m.objetivo,1):0};
    });
    // ── Semáforo ──
    const eSolv = totalDeuda>0 ? (solvencia>1.5?'verde':solvencia>=1?'amarillo':'rojo') : 'neutro';
    const eFE   = totalGastos>0 ? (fondoEmergMeses>6?'verde':fondoEmergMeses>=3?'amarillo':'rojo') : 'neutro';
    const eCI   = (pctConsumoIng<.2?'verde':pctConsumoIng<.3?'amarillo':'rojo');
    const eRA   = totalDeuda>0 ? (ratioApal>.5?'verde':ratioApal>.25?'amarillo':'rojo') : 'neutro';
    const eRegla= reglaOk?'verde':'amarillo';
    const eSaldo= anual.saldo>=0?'verde':'rojo';
    const eSup  = superavit>=0?'verde':'rojo';
    const semaforo = [
      {area:'Nivel de solvencia', estado:eSolv, valor: totalDeuda>0?(solvencia.toFixed(2)+'×'):'Sin deuda'},
      {area:'Fondo de emergencia', estado:eFE, valor: fondoEmergMeses.toFixed(1)+' meses'},
      {area:'Deuda de consumo / ingreso', estado:eCI, valor: pct(pctConsumoIng)},
      {area:'Apalancamiento de deuda', estado:eRA, valor: totalDeuda>0?pct(ratioApal):'Sin deuda'},
      {area:'Regla de presupuesto', estado:eRegla, valor: reglaOk?'En meta':'Por ajustar'},
      {area:'Saldo anual proyectado', estado:eSaldo, valor: fmt(anual.saldo)},
      {area:'Superávit mensual', estado:eSup, valor: fmt(superavit)}
    ];
    // ── Diagnóstico ──
    const fortalezas=[], alertas=[];
    semaforo.forEach(s=>{
      if(s.estado==='verde') fortalezas.push(s.area + ' — ' + s.valor);
      else if(s.estado==='amarillo'||s.estado==='rojo') alertas.push({txt:s.area + ' — ' + s.valor, estado:s.estado});
    });
    if(soloIntereses.length) alertas.unshift({txt:'Deudas que solo pagan intereses (no amortizan): ' + soloIntereses.join(', '), estado:'rojo'});
    if(superavit<0) alertas.push({txt:'Tu salida mensual supera tus ingresos; conviene ajustar gastos.', estado:'rojo'});
    if(ratioConsumo>=.6) alertas.push({txt:'Alta concentración de deuda de consumo ('+pct(ratioConsumo)+').', estado:'rojo'});

    // ── Sección FISCAL ──
    let fiscal = null;
    try { fiscal = buildFiscalReportSection(); } catch(e){ console.error('Error sección fiscal informe:', e); fiscal=null; }
    // ── Sección SUCESORAL ──
    let sucesion = null;
    try { sucesion = buildSucesionReportSection(totalActivos); } catch(e){ console.error('Error sección sucesoral informe:', e); sucesion=null; }
    // ── Diagrama de estructura legal (SVG para el PDF) ──
    let diagramaSVG = null;
    try { diagramaSVG = (typeof buildEstructuraDiagramaSVG === 'function') ? buildEstructuraDiagramaSVG(activosNorm) : null; } catch(e){ diagramaSVG=null; }

    return {
      cliente: reportClientName(),
      fecha: new Date().toLocaleDateString('es-CO',{day:'numeric',month:'long',year:'numeric'}),
      nota: (state.tablero.informeNota||'').trim(),
      resumen: {patrimonio, ingresoMensual, totalGastos, servicioDeuda, totalAhorro, superavit},
      semaforo,
      ingresos: {filas:ingresosFilas, total:ingresoMensual, variable: varDetalle,
                 hogar:{socio1:state.p5.socio1||'', socio2:state.p5.socio2||'', modo:(state.tablero.couple&&state.tablero.couple.modo)||'proporcional'}},
      gastos: {filas:gastosFilas, detalle:gastosDetalle, totalNec, totalDes, total:totalGastos, anuales:anualesGastos},
      deudas: {filas:deudasFilas, totalDeuda, servicioDeuda, tasaProm, pctConsumoIng, ratioConsumo, ratioApal, soloIntereses},
      activos: {filas:activosFilas, totalLiquido, totalNoLiquido, total:totalActivos, patrimonio, solvencia, pctLiquidos, totalRentaMensual},
      ahorro: {precaucion:ahorroPrec, inversion:ahorroInv, total:totalAhorro, capacidadPct, fondoEmergMeses, fondoEstab, provisiones},
      presupuesto: {regla:reglaRows, uso:usoRows, anual, ingresoRegla, ingresoMensualBase:ingresoMensual, ingresoAnualProrr:(state.p5.ingAnual||0)/12, reglaNombre, reglaOk},
      plan, metas,
      diagnostico: {fortalezas, alertas},
      fiscal,
      sucesion,
      estructuraLegal: buildLegalReportSection(),
      diagramaSVG
    };
  }

  /* ─── Sección FISCAL para el informe M9 ─── */
  function buildFiscalReportSection(){
    if(typeof pfImpuestoPatrimonio !== 'function') return null;
    const f = state.fiscal || {};
    // Solo incluir si el usuario tocó algo del módulo fiscal (evita una sección vacía).
    const tocado = f.actividad || (f.resp && (f.resp.iva||f.resp.ica||f.resp.retencion)) || f.regimen || (f.sas && (f.sas.costosNegocio||f.sas.salario)) || (state.activos||[]).length>0;
    if(!tocado) return null;
    const decl = (typeof pfDebeDeclarar === 'function') ? pfDebeDeclarar() : null;
    const renta = (typeof pfRentaEstimada === 'function') ? pfRentaEstimada() : null;
    const iva = (typeof pfIvaPeriodo === 'function') ? pfIvaPeriodo() : null;
    const ica = (typeof pfIcaEstimado === 'function') ? pfIcaEstimado() : null;
    const patrim = pfImpuestoPatrimonio();
    // Comparación de régimen (solo si hay actividad de negocio con ingresos)
    let regimen = null;
    try {
      if(typeof pfSasEstimado === 'function' && typeof pfRentaEstimada === 'function'){
        const pn = pfRentaEstimada().impuesto || 0;
        const sas = pfSasEstimado();
        const eligS = (typeof pfSasElegibleSimple==='function') ? pfSasElegibleSimple() : {elegible:false};
        const sasS = (eligS.elegible && typeof pfSasSimpleEstimado==='function') ? pfSasSimpleEstimado() : null;
        const ops = [{k:'pn', nombre:'Persona natural (como hoy)', total:pn}];
        if(sas) ops.push({k:'ord', nombre:'SAS · Ordinario', total:sas.total});
        if(sasS) ops.push({k:'simple', nombre:'SAS · Simple', total:sasS.total});
        if(ops.length>1){
          const ganador = ops.reduce((a,b)=> b.total<a.total?b:a);
          regimen = { ops, ganador:ganador.nombre, ahorroVsHoy: Math.max(0, pn - ganador.total) };
        }
      }
    } catch(e){ regimen=null; }
    return {
      declara: decl ? { debe:decl.debe, razones:(decl.razones||[]).map(r=>r.k) } : null,
      renta: renta ? { ingresos:renta.ingresos||0, baseGravable:renta.baseGravable||0, impuesto:renta.impuesto||0,
                       retencion:renta.retencion||0, saldo:renta.saldo||0, esSimple:!!renta.esSimple } : null,
      iva, ica, patrimonio: patrim, regimen
    };
  }

  /* ─── Sección SUCESORAL para el informe M9 ─── */
  function buildSucesionReportSection(totalActivos){
    const L = (state.fiscal && state.fiscal.legal) || null;
    if(!L) return null;
    const tocado = L.estadoCivil || (L.hijosMenores||0)>0 || (L.testamento && L.testamento.tiene!==null) || (L.segurosVida||[]).length>0;
    if(!tocado) return null;
    const bruto = totalActivos || 0;
    const conyugal = L.regimenConyugal === 'sociedad_conyugal';
    const gananciales = conyugal ? 0.5 : 1;
    const acervoHeredable = bruto * gananciales;
    const impuesto = (typeof pfImpuestoHerenciaEstimado === 'function') ? pfImpuestoHerenciaEstimado(acervoHeredable) : 0;
    const segurosSuma = (L.segurosVida||[]).reduce((s,x)=>s+(x.sumaAsegurada||0),0);
    const dependientes = (L.hijosMenores||0)+(L.hijosMayoresDependientes||0)+(L.otrosDependientes||0);
    return {
      estadoCivil: L.estadoCivil||'—', regimen: conyugal?'Sociedad conyugal':(L.regimenConyugal||'—'),
      dependientes, hijosMenores:L.hijosMenores||0,
      tieneTestamento: !!(L.testamento && L.testamento.tiene===true),
      brutoPatrimonio: bruto, gananciales, acervoHeredable, impuestoHerencia:impuesto,
      segurosVidaSuma: segurosSuma,
      liquidezVsImpuesto: segurosSuma - impuesto,
      guardaDesignada: L.guardaDesignada===true, guardaFalta: (L.hijosMenores||0)>0 && L.guardaDesignada===false
    };
  }


  /* ─── Sección legal para el informe M9 ─── */
  function buildLegalReportSection(){
    if(typeof evaluarEstructuraLegal !== 'function') return null;
    const L = (state.fiscal && state.fiscal.legal) || null;
    if(!L) return null;
    const llenoAlgo =
      L.estadoCivil ||
      (L.testamento && L.testamento.tiene !== null) ||
      (L.avalesTerceros && L.avalesTerceros.tiene !== null) ||
      (L.pleitosVigentes && L.pleitosVigentes.tieneComoDemandado !== null) ||
      (L.segurosVida && L.segurosVida.length > 0);
    if(!llenoAlgo) return null;

    let result;
    try { result = evaluarEstructuraLegal(); }
    catch(e){ console.error('Error evaluando estructura legal para informe:', e); return null; }

    const { hallazgos, palancas, resumen } = result;
    const ordenSev = { alta:0, media:1, info:2, ok:3 };
    hallazgos.sort((a,b) => (ordenSev[a.sev]||9) - (ordenSev[b.sev]||9));

    return {
      datos: {
        estadoCivil: L.estadoCivil || '—',
        regimen: L.regimenConyugal || '—',
        dependientes: (L.hijosMenores||0) + (L.hijosMayoresDependientes||0) + (L.otrosDependientes||0),
        hijosMenores: L.hijosMenores || 0,
        tieneTestamento: L.testamento && L.testamento.tiene === true,
        anioTestamento: (L.testamento && L.testamento.anioOtorgamiento) || null,
        segurosVidaCantidad: (L.segurosVida||[]).length,
        segurosVidaSuma: (L.segurosVida||[]).reduce((s,x)=>s+(x.sumaAsegurada||0),0),
        tieneAvales: L.avalesTerceros && L.avalesTerceros.tiene === true,
        avalesMonto: (L.avalesTerceros && L.avalesTerceros.monto) || 0,
        tienePleitos: L.pleitosVigentes && L.pleitosVigentes.tieneComoDemandado === true,
        pleitosMonto: (L.pleitosVigentes && L.pleitosVigentes.montoPretensiones) || 0,
        tieneInvalidez: (L.coberturas && L.coberturas.invalidez && L.coberturas.invalidez.tiene === true),
        invalidezRenta: (L.coberturas && L.coberturas.invalidez && L.coberturas.invalidez.rentaMensual) || 0,
        viviendaProtegida: L.viviendaProtegida === true,
        avalSociedad: L.avalSociedad === true,
        protocoloFamiliar: L.protocoloFamiliar === true,
        guardaDesignada: L.guardaDesignada === true
      },
      hallazgos, palancas, resumen
    };
  }

  /* ── Helpers de armado del PDF ── */
  function rptSemHex(e){ return e==='verde'?'#1a7f4b':e==='amarillo'?'#9a6b00':e==='rojo'?'#b3261e':'#777'; }
  function rptSemTxt(e){ return e==='verde'?'Bien':e==='amarillo'?'Atención':e==='rojo'?'Crítico':'—'; }
  var RPT_ACCENT = '#0e4d3a';
  function rptTableLayout(){
    return {
      fillColor: (rowIndex) => rowIndex===0 ? RPT_ACCENT : (rowIndex%2===0 ? '#f3f6f5' : null),
      hLineWidth: ()=>0.5, vLineWidth: ()=>0, hLineColor: ()=>'#e3e6e5',
      paddingTop: ()=>5, paddingBottom: ()=>5, paddingLeft: ()=>7, paddingRight: ()=>7
    };
  }
  function rptSection(t){ return {text:t, style:'h2', margin:[0,16,0,7]}; }
  function rptKpiGrid(items){
    const rows=[]; for(let i=0;i<items.length;i+=3){
      const slice = items.slice(i,i+3);
      while(slice.length<3) slice.push(null);
      rows.push(slice.map(it=> it ? {
        stack:[ {text:it.label, fontSize:8, color:'#6a6f6d', margin:[0,0,0,2]}, {text:it.value, fontSize:13, bold:true, color:it.color||'#16201c'} ],
        margin:[0,3,0,3]
      } : {text:''}));
    }
    return {table:{widths:['*','*','*'], body:rows}, layout:'noBorders', margin:[0,0,0,4]};
  }
  function rptTable(headers, rows, widths){
    const body=[ headers.map(h=>({text:h, color:'#ffffff', bold:true, fontSize:8.5})) ];
    rows.forEach(r=> body.push(r));
    return {table:{headerRows:1, widths:widths, body:body}, layout:rptTableLayout(), fontSize:9, margin:[0,2,0,6]};
  }
  function rptCell(t){ return {text:(t==null?'':t), fontSize:9}; }
  function rptCellR(t){ return {text:(t==null?'':t), fontSize:9, alignment:'right'}; }

  function buildReportDoc(d, logo){
    const content=[];
    // ── Portada ──
    if(logo) content.push({image:logo, width:150, alignment:'center', margin:[0,40,0,18]});
    else content.push({text:'ABBA', style:'cover', alignment:'center', margin:[0,60,0,18]});
    content.push({text:'Resumen financiero detallado', fontSize:22, bold:true, color:RPT_ACCENT, alignment:'center', margin:[0,0,0,4]});
    content.push({text:'Preparado para mi asesor financiero', fontSize:12, color:'#6a6f6d', alignment:'center', margin:[0,0,0,26]});
    content.push({text:d.cliente, fontSize:15, bold:true, alignment:'center', margin:[0,0,0,3]});
    content.push({text:'Generado el ' + d.fecha, fontSize:10, color:'#6a6f6d', alignment:'center', margin:[0,0,0,24]});
    if(d.nota) content.push({table:{widths:['*'], body:[[{stack:[{text:'Mensaje para mi asesor', bold:true, fontSize:9, color:RPT_ACCENT, margin:[0,0,0,4]},{text:d.nota, fontSize:10}], margin:[4,4,4,4]}]]}, layout:{fillColor:()=>'#f3f6f5', hLineWidth:()=>0, vLineWidth:()=>0}, margin:[30,0,30,0]});
    content.push({text:'Información al ' + d.fecha + '. Es una foto del momento. Documento informativo; no constituye asesoría financiera.', fontSize:7.5, color:'#9aa0a8', italics:true, alignment:'center', margin:[0,40,0,0]});

    // ── Resumen ejecutivo ──
    content.push({text:'Resumen ejecutivo', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    content.push(rptKpiGrid([
      {label:'Patrimonio neto', value:fmt(d.resumen.patrimonio), color:d.resumen.patrimonio>=0?'#1a7f4b':'#b3261e'},
      {label:'Ingreso mensual', value:fmt(d.resumen.ingresoMensual)},
      {label:'Gastos mensuales', value:fmt(d.resumen.totalGastos)},
      {label:'Servicio de deuda', value:fmt(d.resumen.servicioDeuda)},
      {label:'Ahorro mensual', value:fmt(d.resumen.totalAhorro)},
      {label:'Superávit mensual', value:fmt(d.resumen.superavit), color:d.resumen.superavit>=0?'#1a7f4b':'#b3261e'}
    ]));
    content.push(rptSection('Semáforo de salud financiera'));
    content.push(rptTable(['Área','Estado','Valor'], d.semaforo.map(s=>[
      rptCell(s.area), {text:rptSemTxt(s.estado), fontSize:9, bold:true, color:rptSemHex(s.estado)}, rptCellR(s.valor)
    ]), ['*',70,90]));

    // ── Ingresos ──
    content.push({text:'Ingresos', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    content.push(rptTable(['Fuente','Monto mensual'], d.ingresos.filas.map(i=>[rptCell(i.nombre), rptCellR(fmt(i.monto))]).concat([[{text:'Total', bold:true, fontSize:9}, {text:fmt(d.ingresos.total), bold:true, fontSize:9, alignment:'right'}]]), ['*',120]));
    if(d.ingresos.variable){
      const v = d.ingresos.variable;
      content.push(rptSection('Ingresos variables — detalle'));
      v.contratos.forEach(c=>{
        content.push({text: c.nombre + (c.tipo && c.tipo!=='—' ? (' · ' + c.tipo) : '') + '   ·   Retención: ' + c.retencion, fontSize:9.5, bold:true, color:RPT_ACCENT, margin:[0,6,0,3]});
        if(c.meses.length){
          content.push(rptTable(['Mes','Bruto','Gastos asociados','Retención','Neto'],
            c.meses.map(m=>[rptCell(m.label), rptCellR(fmt(m.bruto)), rptCellR(fmt(m.costos)), rptCellR(fmt(m.tributo)), rptCellR(fmt(m.neto))]),
            ['*','auto','auto','auto','auto']));
        } else content.push({text:'Sin historial registrado.', fontSize:9, color:'#6a6f6d', margin:[0,0,0,4]});
      });
      content.push({text:'Total combinado del historial', fontSize:9.5, bold:true, margin:[0,6,0,3]});
      content.push(rptTable(['Concepto','Valor'], [
        [rptCell('Bruto acumulado'), rptCellR(fmt(v.totales.bruto))],
        [rptCell('Gastos asociados acumulados'), rptCellR(fmt(v.totales.costos))],
        [rptCell('Retención reservada acumulada'), rptCellR(fmt(v.totales.tributo))],
        [{text:'Neto acumulado', bold:true, fontSize:9}, {text:fmt(v.totales.neto), bold:true, fontSize:9, alignment:'right'}]
      ], ['*',130]));
      content.push(rptKpiGrid([
        {label:'Salario sostenible (base mensual)', value:fmt(v.salarioSostenible)},
        {label:'Fondo de estabilización actual', value:fmt(v.fondoActual)},
        {label:'Meta del fondo de estabilización', value:fmt(v.fondoMeta)}
      ]));
    }
    if(d.ingresos.hogar.socio1 || d.ingresos.hogar.socio2) content.push({text:'Hogar: ' + (d.ingresos.hogar.socio1||'—') + (d.ingresos.hogar.socio2?(' y ' + d.ingresos.hogar.socio2):'') + ' · reparto ' + d.ingresos.hogar.modo, fontSize:9, color:'#6a6f6d'});

    // ── Gastos ──
    content.push({text:'Gastos', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    content.push({text:'Detalle de todos los gastos por concepto', fontSize:9, color:'#6a6f6d', margin:[0,0,0,4]});
    content.push(rptTable(['Categoría','Concepto','Clasificación','Monto mensual'],
      d.gastos.detalle.map(g=>[rptCell(g.cat), rptCell(g.concepto), rptCell(g.bucket), rptCellR(fmt(g.monto))]),
      ['auto','*','auto','auto']));
    content.push({text:'Necesidades: ' + fmt(d.gastos.totalNec) + '  ·  Deseos: ' + fmt(d.gastos.totalDes) + '  ·  Total: ' + fmt(d.gastos.total), fontSize:9, bold:true, margin:[0,0,0,6]});
    if(d.gastos.anuales.length){
      content.push(rptSection('Gastos anuales / estacionales'));
      content.push(rptTable(['Concepto','Mes','Monto'], d.gastos.anuales.map(a=>[rptCell(a.concepto), rptCell(a.mes), rptCellR(fmt(a.monto))]), ['*',90,110]));
    }

    // ── Endeudamiento ──
    content.push({text:'Endeudamiento', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    if(d.deudas.filas.length){
      content.push(rptTable(['Deuda','Tipo','Saldo','Tasa E.A.','Cuota','Solo interés'], d.deudas.filas.map(x=>[
        rptCell(x.nombre), {text:x.tipo, fontSize:8}, rptCellR(fmt(x.saldo)), rptCellR((x.tasa*100).toFixed(1)+'%'), rptCellR(fmt(x.cuota)),
        {text:x.soloIntereses?'Sí':'—', fontSize:9, alignment:'center', color:x.soloIntereses?'#b3261e':'#777', bold:x.soloIntereses}
      ]), ['*',88,'auto','auto','auto',46]));
      content.push({text:'Deuda total: ' + fmt(d.deudas.totalDeuda) + '  ·  Servicio mensual: ' + fmt(d.deudas.servicioDeuda) + '  ·  Tasa promedio: ' + (d.deudas.tasaProm*100).toFixed(1) + '% E.A.', fontSize:9, bold:true, margin:[0,0,0,8]});
      content.push(rptSection('Ratios de deuda'));
      content.push(rptTable(['Indicador','Valor'], [
        [rptCell('Pagos de consumo / ingreso'), rptCellR(pct(d.deudas.pctConsumoIng))],
        [rptCell('Ratio de deuda de consumo'), rptCellR(pct(d.deudas.ratioConsumo))],
        [rptCell('Ratio de apalancamiento'), rptCellR(pct(d.deudas.ratioApal))]
      ], ['*',120]));
      if(d.deudas.soloIntereses.length) content.push({text:'⚠ Deudas que solo pagan intereses (no amortizan): ' + d.deudas.soloIntereses.join(', '), fontSize:9, color:'#b3261e', bold:true, margin:[0,4,0,0]});
    } else content.push({text:'No hay deudas registradas.', fontSize:10, color:'#6a6f6d'});

    // ── Activos y patrimonio ──
    content.push({text:'Activos y patrimonio', style:'h1', pageBreak:'before', pageOrientation:'landscape', margin:[0,0,0,8]});
    content.push({text:'Detalle completo de cada activo, con la parte que es tuya, a nombre de quién está y la renta que genera.', fontSize:9, color:'#6a6f6d', margin:[0,0,0,6]});
    const aHead = ['Activo','Tipo de bien','A nombre de','Tu %','Valor (tu parte)','Renta/mes','Deuda','Neto','Sector','Ubicación'];
    const aRows = d.activos.filas.map(a=>{
      const marcas=[];
      if(a.reparto) marcas.push(a.reparto==='Repartida'?'fondo diversificado':'una sola empresa');
      if(a.beneficioTrib) marcas.push('beneficio tributario');
      if(a.restringido) marcas.push('restringido');
      const nombreCell = marcas.length
        ? {stack:[{text:a.nombre, fontSize:8.5}, {text:marcas.join(' · '), fontSize:7, italics:true, color:'#6a6f6d'}]}
        : {text:a.nombre, fontSize:8.5};
      return [
        nombreCell,
        {text:a.subtipo, fontSize:8},
        {text:a.estructura, fontSize:8},
        {text:a.participacion + '%', fontSize:8.5, alignment:'right'},
        {text:fmt(a.valor), fontSize:8.5, alignment:'right'},
        {text:a.renta>0?fmt(a.renta):'—', fontSize:8.5, alignment:'right'},
        {text:a.deuda>0?fmt(a.deuda):'—', fontSize:8.5, alignment:'right'},
        {text:fmt(a.neto), fontSize:8.5, alignment:'right'},
        {text:a.sector||'—', fontSize:8},
        {text:a.moneda!=='COP' ? (a.pais+' · '+a.moneda) : a.pais, fontSize:8}
      ];
    });
    content.push(rptTable(aHead, aRows, [104,92,78,28,82,64,64,82,74,64]));
    content.push({text:'Líquidos: ' + fmt(d.activos.totalLiquido) + '  ·  No líquidos: ' + fmt(d.activos.totalNoLiquido) + '  ·  Total: ' + fmt(d.activos.total) + (d.activos.totalRentaMensual>0?('  ·  Renta mensual de los activos: ' + fmt(d.activos.totalRentaMensual)):''), fontSize:9, bold:true, margin:[0,2,0,6]});
    content.push(rptKpiGrid([
      {label:'Patrimonio neto (activos − deuda)', value:fmt(d.activos.patrimonio), color:d.activos.patrimonio>=0?'#1a7f4b':'#b3261e'},
      {label:'Nivel de solvencia', value: d.deudas.totalDeuda>0?(d.activos.solvencia.toFixed(2)+'×'):'Sin deuda'},
      {label:'% activos líquidos', value:pct(d.activos.pctLiquidos)}
    ]));
    content.push({text:'Los valores son la parte que te corresponde según tu participación. La renta es el ingreso mensual real que genera cada activo.', fontSize:8, italics:true, color:'#9aa0a8', margin:[0,4,0,0]});

    // ── Ahorro y solvencia (vuelve a vertical) ──
    content.push({text:'Ahorro y solvencia', style:'h1', pageBreak:'before', pageOrientation:'portrait', margin:[0,0,0,8]});
    content.push(rptTable(['Concepto','Monto mensual'], [
      [rptCell('Ahorro de precaución (colchón)'), rptCellR(fmt(d.ahorro.precaucion))],
      [rptCell('Ahorro / inversión'), rptCellR(fmt(d.ahorro.inversion))],
      [{text:'Total ahorro mensual', bold:true, fontSize:9}, {text:fmt(d.ahorro.total), bold:true, fontSize:9, alignment:'right'}]
    ], ['*',120]));
    content.push(rptKpiGrid([
      {label:'Capacidad de ahorro/inversión', value:pct(d.ahorro.capacidadPct)},
      {label:'Fondo de emergencia', value:d.ahorro.fondoEmergMeses.toFixed(1)+' meses'},
      {label:'Fondo de estabilización', value:fmt(d.ahorro.fondoEstab)},
      {label:'Fondo de provisiones', value:fmt(d.ahorro.provisiones)}
    ]));

    // ── Presupuesto ──
    content.push({text:'Presupuesto', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    content.push({text:'Regla elegida: ' + d.presupuesto.reglaNombre, fontSize:11, bold:true, color:RPT_ACCENT, margin:[0,0,0,3]});
    content.push({text:'Calculada sobre un ingreso base de ' + fmt(d.presupuesto.ingresoRegla) + ' al mes (ingreso mensual del hogar ' + fmt(d.presupuesto.ingresoMensualBase) + (d.presupuesto.ingresoAnualProrr>0 ? (' + ingresos anuales prorrateados ' + fmt(d.presupuesto.ingresoAnualProrr)) : '') + ').', fontSize:9, color:'#6a6f6d', margin:[0,0,0,7]});
    content.push(rptTable(['Cubeta','Real','% real','Meta %','Meta $','Diferencia vs meta'], d.presupuesto.regla.map(r=>{
      const ok = r.estado==='ok';
      return [
        rptCell(r.cubeta), rptCellR(fmt(r.real)), rptCellR((r.pct*100).toFixed(0)+'%'),
        rptCellR(r.meta+'%'), rptCellR(fmt(r.metaAmt)),
        {text:r.detalle, fontSize:8.5, color: ok?'#1a7f4b':(r.estado==='excede'?'#b3261e':'#9a6b00'), alignment:'right'}
      ];
    }), ['*','auto','auto','auto','auto',140]));
    content.push({text: d.presupuesto.reglaOk ? '✓ Estás dentro de la regla en las tres cubetas.' : 'Hay cubetas fuera de la meta (ver diferencia arriba).', fontSize:9, bold:true, color: d.presupuesto.reglaOk?'#1a7f4b':'#9a6b00', margin:[0,2,0,4]});
    content.push(rptSection('Uso mensual del dinero'));
    content.push(rptTable(['Concepto','Valor','% ingreso'], d.presupuesto.uso.map(u=>[rptCell(u.concepto), rptCellR(fmt(u.valor)), rptCellR((u.pct*100).toFixed(0)+'%')]), ['*',120,80]));
    if(d.presupuesto.anual.abonoMensual>0) content.push({text:'Incluye ' + fmt(d.presupuesto.anual.abonoMensual) + ' de abono extra a deuda comprometido en el simulador.', fontSize:8.5, color:'#1f6f8b', margin:[0,0,0,6]});
    content.push(rptSection('Proyección anual'));
    const an=d.presupuesto.anual;
    content.push(rptTable(['Concepto','Anual'], [
      [rptCell('Otros ingresos'), rptCellR(fmt(an.ing))],
      [rptCell('Otro ahorro'), rptCellR(fmt(an.aho))],
      [rptCell('Otros pagos de deuda'), rptCellR(fmt(an.deu))],
      [rptCell('Otros gastos'), rptCellR(fmt(an.gas))],
      [{text:'Saldo anual proyectado', bold:true, fontSize:9}, {text:fmt(an.saldo), bold:true, fontSize:9, alignment:'right', color:an.saldo>=0?'#1a7f4b':'#b3261e'}]
    ], ['*',120]));
    if(an.abono) content.push({text:'Abono extraordinario a deuda de ' + fmt(an.abono.monto) + ' en el mes ' + an.abono.mes + ', financiado con ' + (an.abono.fuente==='ahorro'?'traslado de ahorros':'ingreso nuevo/prima') + '. Al estar financiado, no cambia el saldo anual.', fontSize:8.5, color:'#1f6f8b', margin:[0,0,0,0]});

    // ── Plan de deudas ──
    content.push({text:'Plan de pago de deudas', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    if(d.plan && d.plan.hasData){
      content.push(rptKpiGrid([
        {label:'Método', value:d.plan.label||'—'},
        {label:'Tiempo a libertad', value:d.plan.estancado?'No termina':mesesATexto(d.plan.mes)},
        {label:'Intereses estimados', value:d.plan.estancado?'—':fmt(d.plan.totalInteres)}
      ]));
      if(d.plan.orden && d.plan.orden.length){
        content.push(rptSection('Orden de ataque'));
        content.push(rptTable(['#','Deuda','Fecha de liberación'], d.plan.orden.map((o,i)=>[
          {text:String(i+1), fontSize:9, alignment:'center'}, rptCell(o.nombre), rptCellR(o.payoffMes!=null?fechaLibertad(o.payoffMes):'No se liquida')
        ]), [26,'*',150]));
      }
      if(d.presupuesto.anual.abonoMensual>0 || (d.presupuesto.anual.abono)) content.push({text:'Este plan está incluido en tus presupuestos (mensual y/o anual).', fontSize:9, color:'#1f6f8b', margin:[0,4,0,0]});
    } else content.push({text:'No has configurado un plan en el simulador de deuda.', fontSize:10, color:'#6a6f6d'});

    // ── Metas ──
    content.push({text:'Metas y proyección', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    if(d.metas.length){
      content.push(rptTable(['Meta','Objetivo','Saldo actual','Avance','Aporte/mes','Fecha','Fuente'], d.metas.map(m=>[
        rptCell(m.nombre), rptCellR(fmt(m.objetivo)), rptCellR(fmt(m.saldo)), {text:(m.avance*100).toFixed(0)+'%', fontSize:9, alignment:'right'}, rptCellR(fmt(m.aporte)), {text:m.fecha, fontSize:8.5, alignment:'center'}, {text:m.fuente, fontSize:8}
      ]), ['*','auto','auto',42,'auto',54,90]));
    } else content.push({text:'No has registrado metas.', fontSize:10, color:'#6a6f6d'});

    // ── Diagnóstico FISCAL (M11) ──
    if(d.fiscal){
      const F = d.fiscal;
      content.push({text:'Diagnóstico fiscal', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
      content.push({text:'Estimación de planeación con tus datos declarados. No reemplaza la liquidación oficial ni el trabajo de tu contador.', fontSize:9, color:'#6a6f6d', margin:[0,0,0,8]});
      // Renta
      if(F.declara){
        content.push({text: F.declara.debe ? 'Obligado a declarar renta' : 'Por ahora no estaría obligado a declarar renta',
          fontSize:11, bold:true, color: F.declara.debe?'#9a6b00':'#1a7f4b', margin:[0,0,0,4]});
        if(F.declara.debe && F.declara.razones.length) content.push({text:'Por: ' + F.declara.razones.join(', '), fontSize:9, color:'#5a635f', margin:[0,0,0,6]});
      }
      if(F.renta){
        content.push(rptSection('Renta estimada'));
        content.push(rptTable(['Concepto','Valor'], [
          [rptCell('Ingresos del año'), rptCellR(fmt(F.renta.ingresos))],
          [rptCell('Base gravable'), rptCellR(fmt(F.renta.baseGravable))],
          [rptCell('Impuesto de renta estimado'), rptCellR(fmt(F.renta.impuesto))],
          [rptCell('Retención en la fuente'), rptCellR(fmt(F.renta.retencion))],
          [{text:'Saldo a pagar estimado', bold:true, fontSize:9}, {text:fmt(F.renta.saldo), bold:true, fontSize:9, alignment:'right'}]
        ], ['*',150]));
      }
      // IVA / ICA
      const tribRows=[];
      if(F.iva) tribRows.push([rptCell('IVA del período (generado − descontable)'), rptCellR(fmt(F.iva.saldo))]);
      if(F.ica && !F.ica.integradoSimple && !F.ica.sinTarifa) tribRows.push([rptCell('ICA estimado' + (F.ica.municipio?(' · '+F.ica.municipio):'')), rptCellR(fmt(F.ica.valor||0))]);
      if(F.ica && F.ica.integradoSimple) tribRows.push([rptCell('ICA'), rptCell('Integrado en el régimen Simple')]);
      if(tribRows.length){ content.push(rptSection('Otros impuestos')); content.push(rptTable(['Concepto','Valor'], tribRows, ['*',150])); }
      // Impuesto al patrimonio
      if(F.patrimonio){
        const P=F.patrimonio;
        content.push(rptSection('Impuesto al patrimonio'));
        content.push(rptTable(['Concepto','Valor'], [
          [rptCell('Patrimonio bruto'), rptCellR(fmt(P.bruto))],
          [rptCell('− Deudas'), rptCellR('−'+fmt(P.deudas))],
          [{text:'Patrimonio líquido', bold:true, fontSize:9}, {text:fmt(P.liquido), bold:true, fontSize:9, alignment:'right'}],
          [rptCell('Umbral del impuesto (72.000 UVT)'), rptCellR(fmt(P.umbral))],
          [rptCell('Impuesto al patrimonio estimado'), rptCellR(fmt(P.impuesto))]
        ], ['*',150]));
        content.push({text: P.obligado ? 'Supera el umbral: obligado a declarar y pagar impuesto al patrimonio (Formulario 420).'
          : (P.enZonaTemporal ? 'Entre 40.000 y 72.000 UVT: podría quedar obligado por el Decreto 1474/2025 (en revisión). Confírmalo con tu contador.'
          : 'Por debajo del umbral: por ahora no pagaría impuesto al patrimonio.'),
          fontSize:9, color: P.obligado?'#9a6b00':(P.enZonaTemporal?'#9a6b00':'#1a7f4b'), margin:[0,4,0,4]});
      }
      // Régimen
      if(F.regimen){
        content.push(rptSection('Comparación de régimen'));
        content.push(rptTable(['Opción','Costo total anual estimado'],
          F.regimen.ops.map(o=>[ {text:o.nombre + (o.nombre===F.regimen.ganador?'  (más económico)':''), fontSize:9, bold:o.nombre===F.regimen.ganador}, rptCellR(fmt(o.total)) ]), ['*',170]));
        if(F.regimen.ahorroVsHoy>0) content.push({text:'Ahorro potencial frente a como estás hoy: ' + fmt(F.regimen.ahorroVsHoy) + ' al año.', fontSize:9, bold:true, color:'#1a7f4b', margin:[0,4,0,0]});
        content.push({text:'La conveniencia de una SAS depende de tus costos reales, tu reparto de utilidades y tu situación completa. Tu contador lo valida.', fontSize:8, italics:true, color:'#9aa0a8', margin:[0,4,0,0]});
      }
    }

    // ── Planeación sucesoral (M14) ──
    if(d.sucesion){
      const S = d.sucesion;
      content.push({text:'Planeación sucesoral', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
      content.push({text:'Qué pasaría con tu patrimonio y tu familia si faltas. Estimación con tus datos declarados.', fontSize:9, color:'#6a6f6d', margin:[0,0,0,8]});
      content.push(rptTable(['Dato','Valor'], [
        [rptCell('Estado civil'), rptCell(S.estadoCivil)],
        [rptCell('Régimen patrimonial'), rptCell(S.regimen)],
        [rptCell('Personas que dependen de ti'), rptCellR(String(S.dependientes))],
        [rptCell('Hijos menores de edad'), rptCellR(String(S.hijosMenores))],
        [rptCell('¿Tiene testamento?'), rptCell(S.tieneTestamento?'Sí':'No')]
      ], ['*',150]));
      content.push(rptSection('Impuesto de herencia estimado (ganancia ocasional)'));
      const filasHer = [[rptCell('Patrimonio bruto'), rptCellR(fmt(S.brutoPatrimonio))]];
      if(S.gananciales < 1) filasHer.push([rptCell('− Gananciales del cónyuge (sociedad conyugal: 50%)'), rptCellR('−'+fmt(S.brutoPatrimonio - S.acervoHeredable))]);
      filasHer.push([{text:'Base que se hereda (acervo)', bold:true, fontSize:9}, {text:fmt(S.acervoHeredable), bold:true, fontSize:9, alignment:'right'}]);
      filasHer.push([rptCell('Impuesto de herencia estimado (15% con exenciones)'), rptCellR(fmt(S.impuestoHerencia))]);
      content.push(rptTable(['Concepto','Valor'], filasHer, ['*',150]));
      content.push(rptSection('Liquidez para tus herederos'));
      content.push(rptTable(['Concepto','Valor'], [
        [rptCell('Seguros de vida con beneficiario (llegan directo)'), rptCellR(fmt(S.segurosVidaSuma))],
        [rptCell('Impuesto que tendrían que pagar'), rptCellR(fmt(S.impuestoHerencia))],
        [{text: S.liquidezVsImpuesto>=0?'Cubierto por los seguros':'Faltante de caja para pagar el impuesto', bold:true, fontSize:9},
         {text: fmt(Math.abs(S.liquidezVsImpuesto)), bold:true, fontSize:9, alignment:'right', color: S.liquidezVsImpuesto>=0?'#1a7f4b':'#b3261e'}]
      ], ['*',150]));
      if(S.liquidezVsImpuesto < 0) content.push({text:'⚠ Tus herederos no tendrían con qué pagar el impuesto sin vender bienes. Un seguro de vida cubre ese faltante.', fontSize:9, color:'#b3261e', bold:true, margin:[0,4,0,0]});
      if(S.guardaFalta) content.push({text:'⚠ Tienes hijos menores y no está definido quién los cuidaría ni administraría su herencia. Conviene dejarlo por escrito.', fontSize:9, color:'#b3261e', margin:[0,4,0,0]});
      content.push({text:'Estimación informativa. El testamento y las capitulaciones se hacen ante notaría con acompañamiento profesional.', fontSize:8, italics:true, color:'#9aa0a8', margin:[0,6,0,0]});
    }

    // ── Diagnóstico automático ──
    content.push({text:'Diagnóstico automático', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    content.push({text:'Fortalezas', style:'h2', margin:[0,4,0,5]});
    if(d.diagnostico.fortalezas.length) d.diagnostico.fortalezas.forEach(t=>content.push({text:'• ' + t, fontSize:9.5, color:'#1a7f4b', margin:[0,0,0,3]}));
    else content.push({text:'—', fontSize:9.5, color:'#6a6f6d'});
    content.push({text:'Alertas y puntos a trabajar', style:'h2', margin:[0,10,0,5]});
    if(d.diagnostico.alertas.length) d.diagnostico.alertas.forEach(a=>content.push({text:'• ' + a.txt, fontSize:9.5, color:rptSemHex(a.estado), margin:[0,0,0,3]}));
    else content.push({text:'Sin alertas. Buen estado general.', fontSize:9.5, color:'#1a7f4b'});

    // ── Estructura Legal Patrimonial (M13) ──
    if(d.estructuraLegal){
      const EL = d.estructuraLegal;
      content.push({text:'Estructura Legal Patrimonial', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
      content.push({
        text:'Este análisis complementa el diagnóstico fiscal con la lente jurídica. Detecta riesgos de protección patrimonial, planeación sucesoral, cumplimiento normativo y adecuación de vehículos jurídicos con base en los datos declarados.',
        fontSize:9.5, color:'#5a635f', margin:[0,0,0,10]
      });

      content.push({text:'Datos declarados', style:'h2', margin:[0,4,0,6]});
      const dep = EL.datos;
      const estadoCivilLabel = {
        soltero:'Soltero(a)', casado:'Casado(a)', union_marital:'Unión marital de hecho',
        divorciado:'Divorciado(a)', viudo:'Viudo(a)'
      }[dep.estadoCivil] || dep.estadoCivil || '—';
      const regimenLabel = {
        sociedad_conyugal:'Sociedad conyugal / patrimonial',
        capitulaciones:'Capitulaciones (separación de bienes)',
        no_se:'No definido'
      }[dep.regimen] || '—';

      content.push(rptTable(
        ['Concepto','Valor'],
        [
          [rptCell('Estado civil'), rptCell(estadoCivilLabel)],
          [rptCell('Régimen económico'), rptCell(regimenLabel)],
          [rptCell('Personas dependientes'), rptCell(String(dep.dependientes)+(dep.hijosMenores>0?' (incluye '+dep.hijosMenores+' menor'+(dep.hijosMenores>1?'es':'')+')':''))],
          [rptCell('Testamento vigente'), rptCell(dep.tieneTestamento ? ('Sí'+(dep.anioTestamento?' — otorgado en '+dep.anioTestamento:'')) : 'No')],
          [rptCell('Seguros de vida'), rptCell(dep.segurosVidaCantidad>0 ? (dep.segurosVidaCantidad+' pólizas · suma total '+fmt(dep.segurosVidaSuma)) : 'No registrados')],
          [rptCell('Avales a terceros'), rptCell(dep.tieneAvales ? fmt(dep.avalesMonto) : 'No')],
          [rptCell('Procesos judiciales como demandado'), rptCell(dep.tienePleitos ? ('Sí — pretensiones '+fmt(dep.pleitosMonto)) : 'No')],
          [rptCell('Seguro de invalidez / incapacidad'), rptCell(dep.tieneInvalidez ? ('Sí'+(dep.invalidezRenta>0?(' — renta '+fmt(dep.invalidezRenta)+'/mes'):'')) : 'No registrado')],
          [rptCell('Vivienda protegida (patrimonio de familia / afectación)'), rptCell(dep.viviendaProtegida ? 'Sí' : 'No')],
          [rptCell('Aval personal sobre deudas de tu sociedad'), rptCell(dep.avalSociedad ? 'Sí (levanta la protección de la sociedad)' : 'No')],
          [rptCell('Protocolo familiar / acuerdo entre socios'), rptCell(dep.protocoloFamiliar ? 'Sí' : 'No')],
          [rptCell('Guarda de menores designada'), rptCell(dep.guardaDesignada ? 'Sí' : (dep.hijosMenores>0?'No':'No aplica'))]
        ],
        ['*', '*']
      ));

      // Diagrama de estructura legal (SVG)
      if(d.diagramaSVG && d.diagramaSVG.svg){
        content.push({text:'Cómo está organizado tu patrimonio', style:'h2', margin:[0,14,0,6]});
        const maxW = 500;
        const w = Math.min(d.diagramaSVG.width, maxW);
        content.push({svg: d.diagramaSVG.svg, width: w, margin:[0,0,0,6]});
        content.push({text:'Agrupado por tipo de bien. Lo que cuelga de una sociedad o figura está un paso separado de ti; lo que está a tu nombre responde directamente contigo.', fontSize:8, italics:true, color:'#9aa0a8', margin:[0,0,0,4]});
      }

      const noOK = EL.hallazgos.filter(h => h.sev !== 'ok');
      if(noOK.length === 0){
        content.push({text:'Sin hallazgos legales con los datos actuales.',
          fontSize:10, color:'#1a7f4b', margin:[0,10,0,4]});
      } else {
        content.push({text:'Hallazgos ('+noOK.length+')', style:'h2', margin:[0,10,0,6]});
        noOK.forEach(h => {
          const colorSev = h.sev==='alta' ? '#b3261e' : (h.sev==='media' ? '#9a6b00' : '#1f6f8b');
          const labelSev = h.sev==='alta' ? 'ALTA' : (h.sev==='media' ? 'MEDIA' : 'INFO');
          content.push({
            table:{
              widths:['auto','*'],
              body:[[
                { text:labelSev, color:'#ffffff', fillColor:colorSev, fontSize:8, bold:true, alignment:'center', margin:[6,4,6,4] },
                {
                  stack:[
                    { text:h.titulo, bold:true, fontSize:10.5, color:'#16201c', margin:[0,2,0,3] },
                    { text:h.descripcion, fontSize:9, color:'#3a423f', margin:[0,0,0,4] },
                    h.accionConcreta ? {
                      text:[{text:'Qué hacer: ', bold:true, fontSize:9}, {text:h.accionConcreta, fontSize:9}],
                      margin:[0,0,0,3]
                    } : null,
                    h.profesionalRequerido || h.estimacionCosto ? {
                      text:[
                        h.profesionalRequerido ? {text:'Profesional: '+h.profesionalRequerido+'.  ', fontSize:8.5, color:'#5a635f'} : '',
                        h.estimacionCosto ? {text:'Costo: '+h.estimacionCosto, fontSize:8.5, color:'#5a635f'} : ''
                      ],
                      margin:[0,0,0,3]
                    } : null,
                    h.norma ? { text:'Norma: '+h.norma, fontSize:8, italics:true, color:'#5a635f' } : null
                  ].filter(x => x !== null),
                  margin:[8,3,4,3]
                }
              ]]
            },
            layout:{
              hLineWidth:()=>0.5, vLineWidth:()=>0,
              hLineColor:()=>'#e3e6e5',
              paddingTop:()=>0, paddingBottom:()=>0
            },
            margin:[0,0,0,6]
          });
        });
      }

      if(EL.palancas && EL.palancas.length > 0){
        content.push({text:'Palancas recomendadas', style:'h2', margin:[0,12,0,6]});
        EL.palancas.forEach(p => {
          content.push({
            stack:[
              { text:'→ '+p.titulo, bold:true, fontSize:10, color:'#0e4d3a', margin:[0,0,0,2] },
              { text:p.descripcion, fontSize:9, color:'#3a423f', margin:[0,0,0,3] },
              p.estimacionCosto ? { text:'Costo referencial: '+p.estimacionCosto, fontSize:8.5, color:'#5a635f' } : null
            ].filter(x => x !== null),
            margin:[0,0,0,6]
          });
        });
      }

      content.push({
        text:'Análisis informativo con base en normativa colombiana vigente y datos declarados. No sustituye asesoría legal para actos concretos (testamentos, capitulaciones, constitución de sociedades). Las estimaciones de costo son órdenes de magnitud referenciales.',
        fontSize:8, italics:true, color:'#5a635f', margin:[0,10,0,0]
      });
    }

    // ── Notas ──
    content.push({text:'Notas', style:'h1', pageBreak:'before', margin:[0,0,0,8]});
    if(d.nota){ content.push({text:'Mensaje del cliente:', bold:true, fontSize:9.5, margin:[0,0,0,3]}); content.push({text:d.nota, fontSize:10, margin:[0,0,0,14]}); }
    content.push({text:'Observaciones de mi asesor:', bold:true, fontSize:9.5, margin:[0,0,0,6]});
    content.push({table:{widths:['*'], heights:[120], body:[[{text:''}]]}, layout:{hLineWidth:()=>0.5, vLineWidth:()=>0.5, hLineColor:()=>'#d0d4d3', vLineColor:()=>'#d0d4d3'}});

    return {
      pageSize:'A4', pageMargins:[40,54,40,46],
      defaultStyle:{fontSize:10, color:'#16201c'},
      styles:{ cover:{fontSize:30, bold:true, color:RPT_ACCENT}, h1:{fontSize:17, bold:true, color:RPT_ACCENT}, h2:{fontSize:11.5, bold:true, color:'#16201c'} },
      header: (currentPage) => currentPage===1 ? null : {
        margin:[40,18,40,0],
        columns:[
          logo ? {image:logo, width:54} : {text:'ABBA', bold:true, color:RPT_ACCENT, fontSize:11},
          {text:'Resumen financiero · ' + d.cliente, alignment:'right', fontSize:8, color:'#9aa0a8', margin:[0,4,0,0]}
        ]
      },
      footer: (currentPage, pageCount) => ({
        margin:[40,8,40,0],
        columns:[
          {text:'Generado por ABBA · Documento informativo, no constituye asesoría', fontSize:7, color:'#9aa0a8'},
          {text:'Página ' + currentPage + ' de ' + pageCount, alignment:'right', fontSize:7, color:'#9aa0a8'}
        ]
      }),
      content
    };
  }

  /* ── Carga del logo a dataURL para incrustarlo ── */
  function loadLogoDataUrl(){
    return new Promise(resolve=>{
      try{
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function(){
          try{
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img,0,0);
            resolve(c.toDataURL('image/png'));
          }catch(_){ resolve(null); }
        };
        img.onerror = ()=>resolve(null);
        img.src = 'logo-abba.png';
      }catch(_){ resolve(null); }
    });
  }

  async function exportInformePDF(){
    if(typeof pdfMake === 'undefined' || !pdfMake.createPdf){
      showToast('No se pudo cargar el generador de PDF. Revisa tu conexión.', 'error');
      return;
    }
    const btn = document.getElementById('m9-export');
    if(btn){ btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Generando PDF…'; }
    try{
      const logo = await loadLogoDataUrl();
      const data = buildReportData();
      const doc = buildReportDoc(data, logo);
      const stamp = new Date().toISOString().slice(0,10);
      const safe = (data.cliente||'cliente').replace(/[^\w\sáéíóúñ-]/gi,'').trim().replace(/\s+/g,'-');
      pdfMake.createPdf(doc).download('Informe-financiero-' + safe + '-' + stamp + '.pdf');
      showToast('Informe generado. Revisa tus descargas.', 'success');
    }catch(err){
      console.error('Error generando informe', err);
      showToast('Ocurrió un error generando el informe.', 'error');
    }finally{
      if(btn){ btn.disabled = false; btn.textContent = btn.dataset.label || 'Exportar PDF'; }
    }
  }

  function renderInformeM9(){
    const nom = document.getElementById('m9-nombre');
    if(nom && document.activeElement !== nom) nom.value = reportClientName();
    const nota = document.getElementById('m9-nota');
    if(nota && document.activeElement !== nota) nota.value = state.tablero.informeNota || '';
    if(nom && !nom.dataset.wired){ nom.dataset.wired='1'; nom.addEventListener('input', function(){ state.tablero.informeNombre = this.value; scheduleSave('tablero'); }); }
    if(nota && !nota.dataset.wired){ nota.dataset.wired='1'; nota.addEventListener('input', function(){ state.tablero.informeNota = this.value; scheduleSave('tablero'); }); }
    const btn = document.getElementById('m9-export');
    if(btn && !btn.dataset.wired){ btn.dataset.wired='1'; btn.addEventListener('click', exportInformePDF); }
  }