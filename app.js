/* ═══════════════════════════════════════════════════════════
   FIREBASE — auth + firestore
   ═══════════════════════════════════════════════════════════ */
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
    1:'Ingresos y Gastos',2:'Endeudamiento',3:'Activos',
    4:'Ahorro y Solvencia',5:'Presupuesto Anual',6:'Tablero de Control',
    7:'Simulador de Deuda',
    8:'Metas y Proyección',
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
    }
  };
  
  /* ═══════════════════════════════════════════════════════════
     HELPERS — formato y parseo
     ═══════════════════════════════════════════════════════════ */
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
    if(id===1){renderIngresosTable();calcM1();}
    if(id===2){calcM2();}
    if(id===3){renderActivosTable();calcM3();}
    if(id===4){renderAhorroTable();calcM4();}
    if(id===5){renderP5Deudas();calcP5Totals();}
    if(id===6){renderTablero();renderCharts();}
    if(id===7){renderDebtSim();}
    if(id===8){renderMetas();}
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
      state.deudas.push({nombre,saldo,cuota_mensual:cuota,tasa_anual:tasa,tipo,grupo,cargos});
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
    document.querySelectorAll('#activos-body .multi-row').forEach(r=>{
      if(r.classList.contains('multi-row-locked')) return;
      const nombre=r.querySelector('input[data-f=nombre]')?.value||'';
      const valor=n(r.querySelector('input[data-f=valor]')?.value);
      const tipo=r.querySelector('select[data-f=tipo]')?.value||'NO LÍQUIDO';
      const restringido=r.querySelector('input[data-f=restringido]')?.checked||false;
      totalActivos+=valor;
      if(tipo==='LÍQUIDO') totalLiquido+=valor; else totalNoLiquido+=valor;
      if(restringido) totalRestringido+=valor;
      state.activos.push({nombre,valor,tipo,restringido});
    });
    const pctL=totalActivos>0?totalLiquido/totalActivos:0;
    const pctNL=totalActivos>0?totalNoLiquido/totalActivos:0;
    const totalDeuda=(state.deudas||[]).reduce((s,d)=>s+(d.saldo||0),0);
    const patrimonioNeto = totalActivos - totalDeuda;
    const patrimonioDisponible = (totalActivos - totalRestringido) - totalDeuda;
    const dispClass = patrimonioDisponible >= 0 ? 'is-pos' : 'is-neg';
    document.getElementById('m3-kpis').innerHTML = `
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

  function renderGastosTable(){
    ensureGastosItems();
    const body=document.getElementById('gastos-body');
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
    const nuevo=document.querySelector(`#gastos-body input[data-labelkey="${key}"]`);
    if(nuevo) nuevo.focus();
  }
  
  function makeMultiRow(fields, opts={}){
    const row=document.createElement('div');
    row.className='multi-row';
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
    const body=document.getElementById('deudas-body');
    const row=makeMultiRow(d,{cells:[deudaCells(d)],namePlaceholder:'Nombre de la deuda (ej: Tarjeta Visa, Préstamo mamá)'});
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
      if(document.getElementById('gastos-body')) renderGastosTable();
      calcM1();
    }
  }
  function addDeudaRow(){
    const cnt=document.querySelectorAll('#deudas-body .multi-row').length;
    if(cnt>=15){showToast('Máximo 15 deudas','error');return;}
    const d={nombre:'',saldo:0,cuota_mensual:0,tasa_anual:0,tipo:'CONSUMO_TARJETA'};
    state.deudas.push(d);
    addDeudaRowFromState(state.deudas.length-1);
  }
  
  function renderActivosTable(){
    const body=document.getElementById('activos-body');
    body.innerHTML='';
  
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
        // Insertar después del fondo de estabilización si existe, si no al inicio
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
        // Asegurar que esté después del fondo de estabilización
        const targetIdx = state.activos.findIndex(a => a.linkedToFondo) === 0 ? 1 : 0;
        if(idx !== targetIdx){
          const item = state.activos.splice(idx,1)[0];
          state.activos.splice(targetIdx, 0, item);
        }
      }
    } else {
      state.activos.forEach(a => { if(a.linkedToProvisiones) delete a.linkedToProvisiones; });
    }
  
    state.activos.forEach((_,i)=>addActivoRowFromState(i));
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
        + '<a href="#" class="it-locked-link" data-go-prov>Ajustar saldo en presupuesto anual</a>'
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
        desc:'Resultado neto del presupuesto anual completo · ingresos − gastos − ahorros − deudas',
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
      ahorroSub = 'Con solo mínimos esa deuda nunca termina; tú sales en ' + mesesATexto(plan.mes);
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

    /* ── Comparación ── */
    html += '<div class="card">'
      + '<div class="card-head"><div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v18M3 7h18M5 7l3 7H2zM19 7l3 7h-6z"/></svg></div><h3>Tu plan vs. pagar solo mínimos</h3></div>'
      + '<div class="ds-cmp">'
      + '<div class="ds-cmp-row head"><span>Escenario</span><span>Tiempo</span><span>Intereses</span></div>'
      + '<div class="ds-cmp-row"><span>Solo pagos mínimos</span><span>' + (minimos.estancado ? 'No termina' : mesesATexto(minimos.mes)) + '</span><span>' + (minimos.estancado ? '—' : fmt(minimos.totalInteres)) + '</span></div>'
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
      + '<span><strong>Incluir este plan en mis presupuestos.</strong> Tu abono extra mensual (' + fmt(ds.capacidadExtra||0) + ') entra al presupuesto mensual del tablero, y tu abono extraordinario' + (ds.abonoMonto>0 ? ' (' + fmt(ds.abonoMonto) + ')' : '') + ' al presupuesto anual. Es reversible: desmárcalo y se quita.</span></label>'
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
      {v:'liquido_total', l:'Todos mis activos líquidos disponibles (M3)'},
      {v:'fondo_provisiones', l:'Fondo de provisiones (M5)'}
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
      kpis.innerHTML =
        '<div class="kpi-grid">'
        + '<div class="kpi is-info"><div class="kpi-label">Patrimonio neto hoy</div><div class="kpi-value">' + fmt(inicial) + '</div><div class="kpi-sub">Activos − deudas</div></div>'
        + '<div class="kpi is-pos span-2"><div class="kpi-label">Patrimonio proyectado a ' + anios + ' años</div><div class="kpi-value">' + fmt(r.final) + '</div><div class="kpi-sub">Aportando ' + fmt(aporte) + '/mes al ' + rendVal + '% anual</div></div>'
        + '<div class="kpi"><div class="kpi-label">Rendimiento generado</div><div class="kpi-value">' + fmt(r.rendimiento) + '</div><div class="kpi-sub">Lo que trabaja tu dinero</div></div>'
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
    state.metas.items.push({nombre:nombre||'', objetivo:0, fecha:'', fuente:'manual', saldoManual:0, aporte:0});
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
  const NAME_TO_ID = {ingresos_gastos:1, endeudamiento:2, activos:3, ahorro:4, presupuesto_anual:5, tablero:6, simulador_deuda:7, metas:8, ingresos_variables:'var'};
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
      case 'activos': return {activos:state.activos};
      case 'ahorro': return {objetivos_ahorro:state.ahorro};
      case 'presupuesto_anual': return state.p5;
      case 'tablero': return state.tablero;
      case 'simulador_deuda': return state.debtSim;
      case 'metas': return state.metas;
      case 'ingresos_variables': return state.varIncome;
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
    if(m3){if(m3.activos) state.activos=m3.activos;completedModules.add(3);}
    if(m4){if(m4.objetivos_ahorro) state.ahorro=m4.objetivos_ahorro;completedModules.add(4);}
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
    renderIngresosTable();calcM1();
    renderGastosTable();
    renderDeudasTable();calcM2();
    renderActivosTable();calcM3();
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
  async function saveM3(){
    calcM3();
    await saveModule('activos',{activos:state.activos});
    completedModules.add(3);updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tus activos se guardaron correctamente.');showToast('Guardado','success');
  }
  async function saveM4(){
    calcM4();
    await saveModule('ahorro',{objetivos_ahorro:state.ahorro});
    completedModules.add(4);updateProgress();updateNavStatus();
    showModal('Módulo guardado','Tu ahorro se guardó correctamente.');showToast('Guardado','success');
  }
  async function saveM5(){
    collectP5State();calcP5Totals();
    await saveModule('presupuesto_anual',state.p5);
    completedModules.add(5);updateProgress();updateNavStatus();
    await regenerateEventosCliente();
    showModal('Módulo guardado','Tu presupuesto anual se guardó correctamente.');showToast('Guardado','success');
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
  document.getElementById('add-activo').addEventListener('click',addActivoRow);
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
  renderGastosTable();
  renderDeudasTable();calcM2();
  renderActivosTable();calcM3();
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
    renderGastosTable();
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
    renderGastosTable();
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
  const DEFINITIONS = {
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