if (!sessionStorage.getItem('authenticated')) {
  window.location.href = 'login.html';
}

const userRole = sessionStorage.getItem('role') || 'usuario';
const userName = sessionStorage.getItem('username') || 'Personal TENS';
const userKey = sessionStorage.getItem('userKey') || 'tens';
const userCargo = sessionStorage.getItem('cargo') || 'Personal Clínico';
const temaVisual = sessionStorage.getItem('temaVisual') || (userKey === 'admin' ? 'admin' : userKey === 'AA' ? 'aa' : 'tens');

let permisos = {};
try {
  permisos = JSON.parse(sessionStorage.getItem('permisos') || '{}');
} catch (e) {
  permisos = {};
}

if (Object.keys(permisos).length === 0) {
  if (userKey === 'admin') {
    permisos = { medicamentos: true, aseo: true, pacientes: true, editar_pacientes: true, agregar_stock: true, supervision: true };
  } else if (userKey === 'AA') {
    permisos = { medicamentos: false, aseo: true, pacientes: false, editar_pacientes: false, agregar_stock: false, supervision: false };
  } else {
    permisos = { medicamentos: true, aseo: false, pacientes: true, editar_pacientes: false, agregar_stock: false, supervision: false };
  }
}

// ============================================================================
// MOTOR DE HORA OFICIAL SANTIAGO, CHILE (America/Santiago · ESCALA 24 HORAS)
// ============================================================================
const ZONA_HORARIA_CHILE = 'America/Santiago';

function obtenerAhoraSantiago() {
  const ahora = new Date();
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA_CHILE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(ahora);

  const map = {};
  partes.forEach(p => { map[p.type] = p.value; });

  const diaSemanaEn = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_HORARIA_CHILE,
    weekday: 'short'
  }).format(ahora);

  const mapaDias = {
    Sun: { index: 0, nombre: 'Domingo' },
    Mon: { index: 1, nombre: 'Lunes' },
    Tue: { index: 2, nombre: 'Martes' },
    Wed: { index: 3, nombre: 'Miércoles' },
    Thu: { index: 4, nombre: 'Jueves' },
    Fri: { index: 5, nombre: 'Viernes' },
    Sat: { index: 6, nombre: 'Sábado' }
  };

  const infoDia = mapaDias[diaSemanaEn] || { index: ahora.getDay(), nombre: 'Lunes' };

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
    diaIndex: infoDia.index,
    diaNombre: infoDia.nombre,
    fechaISO: `${map.year}-${map.month}-${map.day}`,
    fechaCL: `${map.day}/${map.month}/${map.year}`,
    hora24: `${map.hour}:${map.minute}`,
    hora24Seg: `${map.hour}:${map.minute}:${map.second}`,
    fechaHora24: `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}:${map.second}`
  };
}

function formatearInstanteASantiago(dateObj) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA_CHILE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(dateObj);

  const map = {};
  partes.forEach(p => { map[p.type] = p.value; });
  return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}:${map.second}`;
}

function formatearFechaHoraSantiago24(valorFecha) {
  if (!valorFecha) return obtenerAhoraSantiago().fechaHora24;
  const texto = String(valorFecha).trim();

  // 1. Formato SQLite UTC "YYYY-MM-DD HH:MM:SS" -> convertir de UTC a Santiago 24h
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(texto)) {
    const isoUtc = texto.replace(' ', 'T') + (texto.length === 16 ? ':00Z' : 'Z');
    const d = new Date(isoUtc);
    if (!isNaN(d.getTime())) {
      return formatearInstanteASantiago(d);
    }
  }

  // 2. Formato ISO con Z u offset (ej. "2026-11-19T21:14:00Z") -> Santiago 24h
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const d = new Date(texto);
    if (!isNaN(d.getTime())) {
      return formatearInstanteASantiago(d);
    }
  }

  // 3. Texto local DD/MM/YYYY o DD-MM-YYYY -> normalizar a escala 24h (00:00 - 23:59)
  const matchLocal = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?/i);
  if (matchLocal) {
    const dd = matchLocal[1].padStart(2, '0');
    const mm = matchLocal[2].padStart(2, '0');
    const yyyy = matchLocal[3];
    let hh = parseInt(matchLocal[4], 10);
    const min = matchLocal[5];
    const seg = matchLocal[6] || '00';
    const mer = (matchLocal[7] || '').toLowerCase().replace(/[\s\.]/g, '');

    if (mer === 'pm' && hh < 12) hh += 12;
    if (mer === 'am' && hh === 12) hh = 0;

    return `${dd}/${mm}/${yyyy} ${String(hh).padStart(2, '0')}:${min}:${seg}`;
  }

  return texto;
}

// ============================================================================
// SINCRONIZACIÓN LITERAL EN TIEMPO REAL (SSE + CANAL LOCAL + POLLING 1.5s)
// ============================================================================
let listaPersonalCache = [];
let inventarioCache = [];
let filtroTurnoActual = 'todos';

let cacheFaltantes = [];
let cacheCategorias = [];
let cacheSupervision = null;
let cacheConsumo = null;

let firmaUltimaActividad = null;
let primeraCargaActividad = true;
let sincronizandoAhora = false;

const canalLocalRT = ('BroadcastChannel' in window) ? new BroadcastChannel('clinica_vital_realtime') : null;
if (canalLocalRT) {
  canalLocalRT.onmessage = (event) => {
    if (event.data && event.data.tipo) {
      sincronizarTodoEnVivo(true);
    }
  };
}

function emitirEventoLocalRT(tipo) {
  if (canalLocalRT) {
    canalLocalRT.postMessage({ tipo, ts: Date.now() });
  }
}

function conectarSSEConReintento() {
  try {
    const sse = new EventSource('/api/stream');
    sse.onmessage = () => {
      sincronizarTodoEnVivo(true);
    };
    sse.onerror = () => {
      sse.close();
      setTimeout(conectarSSEConReintento, 4000);
    };
  } catch (e) {
    // Respaldo continuo activo mediante polling cada 1.5s
  }
}

function iniciarConexionTiempoReal() {
  conectarSSEConReintento();

  // Polling continuo de alta frecuencia (cada 1.5 segundos) para sincronizar entre distintos navegadores/equipos
  setInterval(() => {
    sincronizarTodoEnVivo(true);
  }, 1500);
}

async function sincronizarTodoEnVivo(silencioso = true) {
  if (sincronizandoAhora) return;
  sincronizandoAhora = true;
  try {
    await cargarInventario();
    await cargarPersonalTiempoReal();

    if (permisos.supervision) {
      await Promise.all([
        cargarActividadReciente(!silencioso || true),
        cargarSupervision(),
        cargarReporteSemanal()
      ]);
    }
  } finally {
    sincronizandoAhora = false;
  }
}

async function sincronizarManualmente() {
  await sincronizarTodoEnVivo(false);
  const st = obtenerAhoraSantiago();
  mostrarToast(`🔄 Sincronizado al instante (${st.hora24Seg} hrs · Santiago)`, 'primary');
}

document.addEventListener('DOMContentLoaded', () => {
  aplicarTemaYPermisos();
  iniciarRelojTurnos();
  cargarInventario();
  cargarPersonalTiempoReal();

  if (permisos.pacientes) {
    cargarPacientes();
  }

  if (permisos.supervision) {
    cargarReporteSemanal();
    cargarSupervision();
    cargarUsuarios();
    cargarActividadReciente(false);
    comprobarAlertasStockAdmin();
  }

  iniciarConexionTiempoReal();
});

document.getElementById('btn-logout').addEventListener('click', () => {
  sessionStorage.clear();
  window.location.href = 'login.html';
});

function mostrarToast(mensaje, tipo = 'dark') {
  const toastEl = document.getElementById('clinicToast');
  const toastBody = document.getElementById('clinicToastBody');
  if (!toastEl || !toastBody) return;
  toastEl.className = `toast align-items-center text-bg-${tipo} border-0 rounded-3 shadow`;
  toastBody.textContent = mensaje;
  bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 4500 }).show();
}

// ============================================================================
// 1. IDENTIDAD VISUAL POR ÁREA Y SEGREGACIÓN DINÁMICA DE PERMISOS
// ============================================================================
function aplicarTemaYPermisos() {
  document.body.setAttribute('data-theme', temaVisual);

  const lblRol = document.getElementById('lbl-rol');
  const heroTitulo = document.getElementById('hero-titulo');
  const heroSubtitulo = document.getElementById('hero-subtitulo');

  if (temaVisual === 'admin') {
    lblRol.textContent = `🛡️ Dirección y Supervisión · ${userName}`;
    heroTitulo.textContent = `Panel Ejecutivo — ${userName}`;
    heroSubtitulo.textContent = 'Control integral de inventario, finanzas ($ CLP), gestión de personal, turnos y monitoreo en tiempo real.';
  } else if (temaVisual === 'aa') {
    lblRol.textContent = `🧼 Aseo e Higiene · ${userName}`;
    heroTitulo.textContent = `Área de Higiene y Apoyo Operativo — ${userName}`;
    heroSubtitulo.textContent = 'Gestión de insumos de sanitización clínica, turnos activos y reporte directo a jefatura.';
  } else {
    lblRol.textContent = `🩺 Enfermería TENS · ${userName}`;
    heroTitulo.textContent = `Estación Clínica y Enfermería — ${userName}`;
    heroSubtitulo.textContent = 'Administración de psicofármacos por pauta, fichas clínicas QR y coordinación de turnos.';
  }

  const secMed = document.getElementById('sec-medicamentos');
  const secAseo = document.getElementById('sec-aseo');
  const alertaSinInv = document.getElementById('alerta-sin-inventario');
  const liPacientes = document.getElementById('pacientes-tab-li');

  if (secMed) secMed.style.display = permisos.medicamentos ? 'block' : 'none';
  if (secAseo) secAseo.style.display = permisos.aseo ? 'block' : 'none';
  if (alertaSinInv && !permisos.medicamentos && !permisos.aseo) {
    alertaSinInv.classList.remove('d-none');
  }

  if (liPacientes) liPacientes.style.display = permisos.pacientes ? 'block' : 'none';

  document.querySelectorAll('.supervision-only').forEach(el => {
    el.style.display = permisos.supervision ? 'inline-block' : 'none';
  });

  document.querySelectorAll('.perm-stock-only').forEach(el => {
    el.style.display = permisos.agregar_stock ? 'inline-block' : 'none';
  });

  document.querySelectorAll('.perm-edit-pac-only').forEach(el => {
    el.style.display = permisos.editar_pacientes ? 'inline-block' : 'none';
  });
}

// ============================================================================
// 2. DESCARGA DIRECTA DE ARCHIVO .CSV
// ============================================================================
function descargarArchivoCSV(filasMatriz, nombreArchivo) {
  const csvContenido = filasMatriz
    .map(fila =>
      fila
        .map(celda => {
          const texto = String(celda ?? '').replace(/[\r\n]+/g, ' ').trim();
          return `"${texto.replace(/"/g, '""')}"`;
        })
        .join(',')
    )
    .join('\r\n');

  const blob = new Blob(['\uFEFF' + csvContenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', nombreArchivo);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  mostrarToast(`📥 Archivo descargado: ${nombreArchivo}`, 'success');
}

// ============================================================================
// 3. COMBINACIÓN DE TECLAS Y REPORTES (Alt + F: Faltantes | Alt + C: Categorías)
// ============================================================================
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const key = e.key.toLowerCase();
  if ((e.altKey && key === 'f') || (e.ctrlKey && e.shiftKey && key === 'f')) {
    e.preventDefault();
    abrirReporteFaltantes();
  } else if ((e.altKey && key === 'c') || (e.ctrlKey && e.shiftKey && key === 'c')) {
    e.preventDefault();
    abrirReporteCategorias();
  } else if (e.altKey && key === 's' && permisos.supervision) {
    e.preventDefault();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSupervision')).show();
  }
});

async function abrirReporteFaltantes() {
  try {
    const res = await fetch('/api/supervision/reorden');
    const data = await res.json();

    const itemsFiltrados = data.detalles.filter(item => {
      const esMed = esMedicamento(item);
      if (!permisos.supervision) {
        if (esMed && !permisos.medicamentos) return false;
        if (!esMed && !permisos.aseo) return false;
      }
      return item.stock <= item.stock_minimo;
    });

    cacheFaltantes = itemsFiltrados;

    const agotados = itemsFiltrados.filter(i => i.stock <= 0).length;
    const bajos = itemsFiltrados.filter(i => i.stock > 0 && i.stock <= i.stock_minimo).length;
    const costoTotal = itemsFiltrados.reduce((acc, i) => acc + i.costo_total_estimado, 0);

    document.getElementById('lbl-faltantes-agotados').textContent = agotados;
    document.getElementById('lbl-faltantes-bajos').textContent = bajos;
    document.getElementById('lbl-faltantes-costo').textContent = `$${costoTotal.toLocaleString('es-CL')} CLP`;

    const tbody = document.getElementById('tabla-reporte-faltantes-body');
    tbody.innerHTML = '';

    if (itemsFiltrados.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-4 text-success fw-bold">
            ✅ Excelente: No existen productos faltantes ni bajo stock mínimo en este momento.
          </td>
        </tr>
      `;
    } else {
      itemsFiltrados.forEach(item => {
        const unidad = esMedicamento(item) ? 'cajas' : 'unidades';
        const estadoBadge = item.stock <= 0
          ? '<span class="badge bg-danger">AGOTADO (0)</span>'
          : '<span class="badge bg-warning text-dark">STOCK CRÍTICO</span>';
        const prioBadge = item.prioridad === 'Alta'
          ? '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Alta</span>'
          : '<span class="badge bg-secondary-subtle text-dark border">' + item.prioridad + '</span>';

        tbody.innerHTML += `
          <tr>
            <td>${estadoBadge}</td>
            <td>${prioBadge}</td>
            <td class="fw-bold text-dark">${item.nombre}</td>
            <td class="text-capitalize">${item.categoria}</td>
            <td><strong>${item.stock}</strong> / ${item.stock_minimo} ${unidad}</td>
            <td class="fw-bold text-primary">+${item.cantidad_a_pedir} ${unidad}</td>
            <td class="fw-bold text-dark">$${item.costo_total_estimado.toLocaleString('es-CL')} CLP</td>
          </tr>
        `;
      });
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalReporteFaltantes')).show();
  } catch (error) {
    console.error('Error al generar reporte de faltantes:', error);
  }
}

function descargarFaltantesCSV() {
  const matriz = [
    ['Estado', 'Prioridad', 'Producto Faltante', 'Categoría', 'Stock Actual', 'Stock Mínimo', 'Faltante a Pedir', 'Costo Reposición ($ CLP)']
  ];
  if (cacheFaltantes.length === 0) {
    matriz.push(['SIN ALERTAS', '-', 'No existen productos faltantes ni bajo stock mínimo', '-', 0, 0, 0, 0]);
  } else {
    cacheFaltantes.forEach(r => {
      matriz.push([
        r.stock <= 0 ? 'AGOTADO' : 'STOCK CRÍTICO',
        r.prioridad,
        r.nombre,
        r.categoria.toUpperCase(),
        r.stock,
        r.stock_minimo,
        r.cantidad_a_pedir,
        r.costo_total_estimado
      ]);
    });
  }
  const fecha = obtenerAhoraSantiago().fechaISO;
  descargarArchivoCSV(matriz, `Faltantes_Clinica_Vital_${fecha}.csv`);
}

async function abrirReporteCategorias() {
  try {
    const res = await fetch('/api/supervision/reorden');
    const data = await res.json();
    cacheCategorias = data.detalles || [];

    const categorias = ['medicamento', 'aseo'];
    const cardsContainer = document.getElementById('cards-resumen-categorias');
    const tbody = document.getElementById('tabla-reporte-categorias-body');
    cardsContainer.innerHTML = '';
    tbody.innerHTML = '';

    categorias.forEach(cat => {
      const itemsCat = cacheCategorias.filter(i => i.categoria === cat);
      const totalUnidades = itemsCat.reduce((acc, i) => acc + i.stock, 0);
      const valorInventario = itemsCat.reduce((acc, i) => acc + (i.stock * i.precio_unitario), 0);
      const consumoSemanal = itemsCat.reduce((acc, i) => acc + i.consumo_semanal, 0);
      const gastoSemanal = itemsCat.reduce((acc, i) => acc + i.costo_consumo_semanal, 0);
      const alertasCat = itemsCat.filter(i => i.stock <= i.stock_minimo).length;

      const tituloCat = cat === 'medicamento' ? '💊 Psicofármacos y Medicamentos' : '🧼 Artículos de Aseo e Higiene';
      const colorBorder = cat === 'medicamento' ? 'border-info' : 'border-success';
      const unidad = cat === 'medicamento' ? 'cajas' : 'unidades';

      cardsContainer.innerHTML += `
        <div class="col-md-6">
          <div class="p-3 rounded-4 border ${colorBorder} bg-light h-100">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <h6 class="fw-bold text-dark m-0">${tituloCat}</h6>
              <span class="badge ${alertasCat > 0 ? 'bg-danger' : 'bg-success'}">${alertasCat} en alerta</span>
            </div>
            <div class="row g-2 text-center mt-1">
              <div class="col-4">
                <div class="bg-white p-2 rounded-3 border">
                  <small class="text-muted d-block" style="font-size:0.72rem;">Stock Total</small>
                  <strong class="text-dark">${totalUnidades} ${unidad}</strong>
                </div>
              </div>
              <div class="col-4">
                <div class="bg-white p-2 rounded-3 border">
                  <small class="text-muted d-block" style="font-size:0.72rem;">Valor en Bodega</small>
                  <strong class="text-primary">$${valorInventario.toLocaleString('es-CL')}</strong>
                </div>
              </div>
              <div class="col-4">
                <div class="bg-white p-2 rounded-3 border">
                  <small class="text-muted d-block" style="font-size:0.72rem;">Consumo 7 Días</small>
                  <strong class="text-success">${consumoSemanal} ($${gastoSemanal.toLocaleString('es-CL')})</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      itemsCat.forEach(item => {
        const valorActual = item.stock * item.precio_unitario;
        tbody.innerHTML += `
          <tr>
            <td><span class="badge ${cat === 'medicamento' ? 'bg-info-subtle text-info-emphasis' : 'bg-success-subtle text-success-emphasis'} text-capitalize">${cat}</span></td>
            <td class="fw-bold text-dark">${item.nombre}</td>
            <td>${item.stock} ${unidad}</td>
            <td class="fw-semibold text-primary">${item.consumo_semanal} ${unidad}</td>
            <td>$${item.precio_unitario.toLocaleString('es-CL')} CLP</td>
            <td class="fw-semibold">$${valorActual.toLocaleString('es-CL')} CLP</td>
            <td class="fw-bold text-success">$${item.costo_consumo_semanal.toLocaleString('es-CL')} CLP</td>
          </tr>
        `;
      });
    });

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalReporteCategorias')).show();
  } catch (error) {
    console.error('Error al generar reporte por categoría:', error);
  }
}

function descargarCategoriasCSV() {
  const matriz = [
    ['Categoría', 'Producto', 'Stock Disponible', 'Consumo Semanal (7d)', 'Precio Unitario ($ CLP)', 'Valor Stock Actual ($ CLP)', 'Gasto Semanal ($ CLP)']
  ];
  cacheCategorias.forEach(r => {
    matriz.push([
      r.categoria.toUpperCase(),
      r.nombre,
      r.stock,
      r.consumo_semanal,
      r.precio_unitario,
      r.stock * r.precio_unitario,
      r.costo_consumo_semanal
    ]);
  });
  const fecha = obtenerAhoraSantiago().fechaISO;
  descargarArchivoCSV(matriz, `Categorias_Clinica_Vital_${fecha}.csv`);
}

// ============================================================================
// 4. MÓDULO DE TURNOS DINÁMICOS (HORARIO SANTIAGO 24H)
// ============================================================================
function iniciarRelojTurnos() {
  const actualizarReloj = () => {
    const st = obtenerAhoraSantiago();
    const relojEl = document.getElementById('reloj-vivo-turnos');
    if (relojEl) {
      relojEl.textContent = `${st.hora24Seg} hrs · Santiago`;
    }
    const relojNav = document.getElementById('reloj-navbar-santiago');
    if (relojNav) {
      relojNav.textContent = `🇨🇱 ${st.hora24Seg} hrs`;
    }
  };
  actualizarReloj();
  setInterval(actualizarReloj, 1000);
}

function parsearRangoMinutos(rangoTexto) {
  const match = (rangoTexto || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const inicio = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  const fin = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
  return [inicio, fin];
}

function obtenerIniciales(nombre) {
  return nombre.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
}

function colorAvatarPorArea(area) {
  const a = (area || '').toLowerCase();
  if (a.includes('enfermer')) return 'background:#e0f2fe;color:#0369a1;';
  if (a.includes('aseo')) return 'background:#d1fae5;color:#065f46;';
  if (a.includes('cocina')) return 'background:#fef3c7;color:#92400e;';
  return 'background:#dbeafe;color:#1e40af;';
}

function filtrarTurnosHoy(filtro, btnEl) {
  filtroTurnoActual = filtro;
  if (btnEl && btnEl.parentElement) {
    btnEl.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }
  renderizarTurnosHoyYManana();
}

async function cargarPersonalTiempoReal() {
  try {
    const res = await fetch('/api/personal');
    const nuevos = await res.json();
    if (JSON.stringify(nuevos) === JSON.stringify(listaPersonalCache) && listaPersonalCache.length > 0) {
      return;
    }
    listaPersonalCache = nuevos;
    renderizarTurnosHoyYManana();
  } catch (error) {
    console.error('Error cargando personal:', error);
  }
}

function renderizarTurnosHoyYManana() {
  const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const st = obtenerAhoraSantiago();
  const hoyIndex = st.diaIndex;
  const mananaIndex = (hoyIndex + 1) % 7;

  const diaHoy = diasSemana[hoyIndex];
  const diaManana = diasSemana[mananaIndex];

  const mananaDate = new Date(Date.now() + 86400000);
  const fechaMananaStr = new Intl.DateTimeFormat('es-CL', {
    timeZone: ZONA_HORARIA_CHILE,
    day: 'numeric',
    month: 'long'
  }).format(mananaDate);

  const fechaHoyStr = new Intl.DateTimeFormat('es-CL', {
    timeZone: ZONA_HORARIA_CHILE,
    day: 'numeric',
    month: 'long'
  }).format(new Date());

  const lblDia = document.getElementById('lbl-dia-actual');
  const lblManana = document.getElementById('lbl-dia-manana');
  if (lblDia) lblDia.textContent = `${diaHoy} ${fechaHoyStr}`;
  if (lblManana) lblManana.textContent = `${diaManana} ${fechaMananaStr}`;

  const gridHoy = document.getElementById('grid-personal-hoy');
  const gridManana = document.getElementById('grid-personal-manana');
  if (!gridHoy || !gridManana) return;

  gridHoy.innerHTML = '';
  gridManana.innerHTML = '';

  const minutosAhora = st.hour * 60 + st.minute;

  let countTodos = listaPersonalCache.length;
  let countActivos = 0;
  let countLibre = 0;

  listaPersonalCache.forEach((p, idx) => {
    const leTocaHoy = p.dias.includes('Todos') || p.dias.includes(diaHoy);
    if (leTocaHoy) countActivos++;
    else countLibre++;

    if (filtroTurnoActual === 'activos' && !leTocaHoy) return;
    if (filtroTurnoActual === 'libre' && leTocaHoy) return;

    const rangoTurno = parsearRangoMinutos(p.horario);
    const rangoColacion = parsearRangoMinutos(p.colacion);

    let cardClass = 'off-today';
    let estadoHTML = '<span class="badge bg-secondary-subtle text-secondary border">Fuera de Turno Hoy</span>';

    if (leTocaHoy) {
      const enColacion = rangoColacion && minutosAhora >= rangoColacion[0] && minutosAhora < rangoColacion[1];
      const enHorario = rangoTurno && minutosAhora >= rangoTurno[0] && minutosAhora < rangoTurno[1];

      if (enColacion) {
        cardClass = 'in-lunch';
        estadoHTML = '<span class="badge bg-warning text-dark fw-bold">🍎 En Colación Ahora</span>';
      } else if (enHorario) {
        cardClass = 'active-today';
        estadoHTML = '<span class="badge bg-success text-white fw-bold"><span class="pulse-dot bg-white"></span>En Turno Activo</span>';
      } else {
        cardClass = 'active-today';
        estadoHTML = '<span class="badge bg-primary-subtle text-primary border border-primary-subtle fw-bold">🕒 Turno Asignado Hoy</span>';
      }
    }

    const botonesAdminTurno = permisos.supervision ? `
      <div class="d-flex justify-content-end gap-1 mt-2 pt-2 border-top">
        <button class="btn btn-outline-warning text-dark btn-sm py-0 px-2 fw-semibold" onclick="abrirModalEditarTurno(${p.id})">✏️ Editar Horario</button>
        <button class="btn btn-outline-danger btn-sm py-0 px-2 fw-semibold" onclick="eliminarTurno(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')">🗑️</button>
      </div>
    ` : '';

    const delay = (idx * 0.05).toFixed(2);
    gridHoy.innerHTML += `
      <div class="col-md-6 col-lg-4">
        <div class="shift-card ${cardClass} h-100" style="animation-delay: ${delay}s;">
          <div class="d-flex justify-content-between align-items-start mb-3">
            <div class="d-flex align-items-center gap-2">
              <div class="avatar-circle" style="${colorAvatarPorArea(p.area)}">${obtenerIniciales(p.nombre)}</div>
              <div>
                <h6 class="fw-bold text-dark mb-0">${p.nombre}</h6>
                <small class="text-secondary fw-semibold">${p.rol}</small>
              </div>
            </div>
            ${estadoHTML}
          </div>

          <div class="bg-light rounded-3 p-2 border small">
            <div class="d-flex justify-content-between mb-1">
              <span class="text-muted">🏥 Área:</span>
              <strong class="text-dark">${p.area}</strong>
            </div>
            <div class="d-flex justify-content-between mb-1">
              <span class="text-muted">⏰ Jornada:</span>
              <strong class="text-primary">${p.horario}</strong>
            </div>
            <div class="d-flex justify-content-between mb-1">
              <span class="text-muted">🍎 Colación:</span>
              <strong class="text-warning-emphasis">${p.colacion}</strong>
            </div>
            <div class="d-flex justify-content-between">
              <span class="text-muted">📅 Días:</span>
              <strong class="text-secondary text-end" style="max-width:65%;">${p.dias}</strong>
            </div>
          </div>
          ${botonesAdminTurno}
        </div>
      </div>
    `;
  });

  document.getElementById('cnt-turnos-todos').textContent = countTodos;
  document.getElementById('cnt-turnos-activos').textContent = countActivos;
  document.getElementById('cnt-turnos-libre').textContent = countLibre;

  // Renderizar Turnos del Día Siguiente (Mañana)
  const personalManana = listaPersonalCache.filter(p => p.dias.includes('Todos') || p.dias.includes(diaManana));
  document.getElementById('badge-total-manana').textContent = `${personalManana.length} Funcionarios Programados`;

  if (personalManana.length === 0) {
    gridManana.innerHTML = `<div class="col-12 text-center text-muted py-3">No hay turnos asignados para ${diaManana}.</div>`;
  } else {
    personalManana.forEach((p, idx) => {
      const trabajabaHoy = p.dias.includes('Todos') || p.dias.includes(diaHoy);
      const tipoRelevoBadge = trabajabaHoy
        ? '<span class="badge bg-info-subtle text-info-emphasis border border-info-subtle">🔄 Continuidad</span>'
        : '<span class="badge bg-primary text-white">✨ Relevo Entrante</span>';

      const delay = (idx * 0.05).toFixed(2);
      gridManana.innerHTML += `
        <div class="col-md-6 col-lg-4">
          <div class="shift-card tomorrow-card h-100" style="animation-delay: ${delay}s;">
            <div class="d-flex justify-content-between align-items-start mb-2">
              <div class="d-flex align-items-center gap-2">
                <div class="avatar-circle" style="${colorAvatarPorArea(p.area)}">${obtenerIniciales(p.nombre)}</div>
                <div>
                  <h6 class="fw-bold text-dark mb-0">${p.nombre}</h6>
                  <small class="text-secondary">${p.rol} · ${p.area}</small>
                </div>
              </div>
              ${tipoRelevoBadge}
            </div>
            <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top small">
              <span class="text-dark fw-semibold">⏰ Ingreso: <span class="text-primary">${p.horario}</span></span>
              <span class="text-muted">🍎 ${p.colacion.split(' ')[0]}</span>
            </div>
          </div>
        </div>
      `;
    });
  }

  renderizarTablaGestionTurnos();
}

function renderizarTablaGestionTurnos() {
  const tbody = document.getElementById('tabla-gestion-turnos-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  listaPersonalCache.forEach(p => {
    tbody.innerHTML += `
      <tr>
        <td class="fw-bold text-dark">${p.nombre}</td>
        <td>
          <div class="fw-semibold text-dark">${p.rol}</div>
          <small class="text-secondary">${p.area}</small>
        </td>
        <td><span class="badge bg-light text-dark border text-wrap text-start">${p.dias}</span></td>
        <td class="fw-bold text-primary">${p.horario}</td>
        <td class="text-warning-emphasis fw-semibold">${p.colacion}</td>
        <td class="text-end">
          <button class="btn btn-outline-warning text-dark btn-sm fw-semibold me-1" onclick="abrirModalEditarTurno(${p.id})">✏️ Editar</button>
          <button class="btn btn-outline-danger btn-sm fw-semibold" onclick="eliminarTurno(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')">🗑️ Eliminar</button>
        </td>
      </tr>
    `;
  });
}

document.getElementById('turno-todos-dias')?.addEventListener('change', (e) => {
  document.querySelectorAll('.chk-dia-turno').forEach(chk => {
    chk.checked = e.target.checked;
    chk.disabled = e.target.checked;
  });
});

function abrirModalNuevoTurno() {
  document.getElementById('modalGestionTurnoTitulo').textContent = '🗓️ Agregar Nuevo Turno de Personal';
  document.getElementById('form-gestion-turno').reset();
  document.getElementById('turno-id').value = '';
  document.getElementById('turno-todos-dias').checked = false;
  document.querySelectorAll('.chk-dia-turno').forEach(chk => {
    chk.disabled = false;
    chk.checked = false;
  });
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionTurno')).show();
}

function abrirModalEditarTurno(id) {
  const p = listaPersonalCache.find(item => item.id === id);
  if (!p) return;

  document.getElementById('modalGestionTurnoTitulo').textContent = `✏️ Editar Turno — ${p.nombre}`;
  document.getElementById('turno-id').value = p.id;
  document.getElementById('turno-nombre').value = p.nombre;
  document.getElementById('turno-rol').value = p.rol;
  document.getElementById('turno-area').value = p.area;

  const matchHorario = (p.horario || '').match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
  document.getElementById('turno-hora-inicio').value = matchHorario ? matchHorario[1] : '08:00';
  document.getElementById('turno-hora-fin').value = matchHorario ? matchHorario[2] : '20:00';

  const matchColacion = (p.colacion || '').match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
  document.getElementById('turno-colacion-inicio').value = matchColacion ? matchColacion[1] : '13:30';
  document.getElementById('turno-colacion-fin').value = matchColacion ? matchColacion[2] : '14:30';

  const esTodos = (p.dias || '').includes('Todos');
  const chkTodos = document.getElementById('turno-todos-dias');
  chkTodos.checked = esTodos;

  document.querySelectorAll('.chk-dia-turno').forEach(chk => {
    chk.disabled = esTodos;
    chk.checked = esTodos || (p.dias || '').includes(chk.value);
  });

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionTurno')).show();
}

document.getElementById('form-gestion-turno')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('turno-id').value;
  const esTodos = document.getElementById('turno-todos-dias').checked;
  const diasSeleccionados = Array.from(document.querySelectorAll('.chk-dia-turno:checked')).map(c => c.value);

  if (!esTodos && diasSeleccionados.length === 0) {
    alert('⚠️ Seleccione al menos un día de turno para el funcionario.');
    return;
  }

  const payload = {
    nombre: document.getElementById('turno-nombre').value,
    rol: document.getElementById('turno-rol').value,
    area: document.getElementById('turno-area').value,
    horario: `${document.getElementById('turno-hora-inicio').value} - ${document.getElementById('turno-hora-fin').value} hrs`,
    colacion: `${document.getElementById('turno-colacion-inicio').value} - ${document.getElementById('turno-colacion-fin').value} hrs`,
    dias: esTodos ? 'Todos los días' : diasSeleccionados.join(', ')
  };

  const url = id ? `/api/personal/${id}` : '/api/personal';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (data.success) {
    bootstrap.Modal.getInstance(document.getElementById('modalGestionTurno')).hide();
    await cargarPersonalTiempoReal();
    emitirEventoLocalRT('turno');
    mostrarToast(id ? '✅ Turno actualizado en tiempo real.' : '✅ Nuevo funcionario agregado al calendario de turnos.', 'success');
  }
});

async function eliminarTurno(id, nombre) {
  if (confirm(`¿Desea eliminar a "${nombre}" de la cartelera de turnos?`)) {
    const res = await fetch(`/api/personal/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      await cargarPersonalTiempoReal();
      emitirEventoLocalRT('turno');
      mostrarToast(`🗑️ Turno de ${nombre} eliminado.`, 'warning');
    }
  }
}

document.getElementById('chk-crear-con-turno')?.addEventListener('change', (e) => {
  const bloque = document.getElementById('bloque-turno-nuevo-usuario');
  if (bloque) bloque.style.display = e.target.checked ? 'block' : 'none';
});

// ============================================================================
// 5. INVENTARIO Y CONSUMO EN TIEMPO REAL
// ============================================================================
function esMedicamento(item) {
  if (item.categoria && item.categoria.toLowerCase() === 'medicamento') return true;
  if (item.categoria && item.categoria.toLowerCase() === 'aseo') return false;
  const nom = item.nombre.toLowerCase();
  return nom.includes('mg') || nom.includes('sertralina') || nom.includes('fluoxetina') || nom.includes('clonazepam') || nom.includes('quetiapina');
}

async function cargarInventario() {
  try {
    const res = await fetch('/api/inventario');
    const items = await res.json();
    inventarioCache = items;

    const tablaMed = document.getElementById('tabla-medicamentos');
    const tablaAseo = document.getElementById('tabla-aseo');
    if (!tablaMed || !tablaAseo) return;

    tablaMed.innerHTML = '';
    tablaAseo.innerHTML = '';

    if (permisos.agregar_stock) {
      poblarSelects(items);
    }

    items.forEach(item => {
      const isMed = esMedicamento(item);
      const unidadLabel = isMed ? 'cajas' : 'unidades';

      let badgeColor = 'bg-success-subtle text-success border border-success-subtle';
      let badgeTexto = `● ${item.stock} ${unidadLabel}`;

      if (item.stock <= 0) {
        badgeColor = 'bg-danger text-white';
        badgeTexto = '⚠️ Agotado (0)';
      } else if (item.stock <= item.stock_minimo) {
        badgeColor = 'bg-warning text-dark';
        badgeTexto = `⚠️ ${item.stock} ${unidadLabel} (Mín: ${item.stock_minimo})`;
      }

      let badgePrioClass = 'bg-secondary-subtle text-secondary border';
      if (item.prioridad === 'Alta') badgePrioClass = 'bg-danger-subtle text-danger border border-danger-subtle';
      else if (item.prioridad === 'Media') badgePrioClass = 'bg-warning-subtle text-warning-emphasis border border-warning-subtle';

      const botonTexto = isMed ? '- Usar 1 Caja' : '- Usar 1 Unidad';
      const btnEstilo = item.stock > 0 ? 'btn-role-primary' : 'btn-outline-danger';

      const fila = `
        <tr>
          <td class="fw-bold text-dark">
            ${item.nombre} 
            ${item.es_sos ? '<span class="badge bg-danger ms-1">SOS</span>' : ''}
          </td>
          <td><span class="badge ${badgeColor} px-3 py-2">${badgeTexto}</span></td>
          <td><span class="badge ${badgePrioClass}">${item.prioridad || 'Media'}</span></td>
          <td class="small text-secondary">${item.pauta || 'N/A'}</td>
          <td class="text-end">
            <button class="btn ${btnEstilo} btn-sm px-3 py-1" onclick="usarUnidad(${item.id}, ${item.stock}, '${item.nombre.replace(/'/g, "\\'")}')">
              ${botonTexto}
            </button>
          </td>
        </tr>
      `;

      if (isMed) {
        tablaMed.innerHTML += fila;
      } else {
        tablaAseo.innerHTML += fila;
      }
    });
  } catch (error) {
    console.error('Error al cargar inventario:', error);
  }
}

async function usarUnidad(id, stockActual, nombreProducto) {
  if (stockActual <= 0) {
    alert('⚠️ Debe reponer stock. El producto se encuentra agotado.');
    return;
  }

  const responsableRegistro = `${userName} (${userCargo})`;
  const st = obtenerAhoraSantiago();

  try {
    const res = await fetch('/api/inventario/usar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        cantidad: 1,
        usuario: responsableRegistro,
        fecha_chile: st.fechaHora24
      })
    });
    
    const data = await res.json();
    
    if (data.success) {
      mostrarToast(`✅ Descontado (${st.hora24} hrs): ${nombreProducto} (Restante: ${data.stockRestante})`, 'success');
      emitirEventoLocalRT('consumo');
      await sincronizarTodoEnVivo(true);
    } else if (data.error) {
      alert(`⚠️ ${data.error}`);
    }
  } catch (error) {
    console.error('Error al descontar unidad:', error);
  }
}

// ============================================================================
// 6. GESTIÓN DE RESIDENTES Y CÓDIGOS QR
// ============================================================================
async function cargarPacientes() {
  try {
    const res = await fetch('/api/pacientes');
    const lista = await res.json();

    const container = document.getElementById('pacientes-container');
    if (!container) return;
    container.innerHTML = '';

    if (lista.length === 0) {
      container.innerHTML = `<div class="col-12 text-center text-muted py-4">No hay residentes registradas actualmente.</div>`;
      return;
    }

    const baseUrl = window.location.origin;

    lista.forEach(p => {
      const urlFicha = `${baseUrl}/ficha/${p.id}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(urlFicha)}`;

      let adminBtns = '';
      if (permisos.editar_pacientes) {
        const archivoImagen = p.imagen_ficha || 'ficha1.png';
        adminBtns = `
          <div class="mt-3 pt-2 border-top d-flex justify-content-end gap-2">
            <button class="btn btn-outline-warning text-dark btn-sm fw-semibold" onclick="abrirModalEditarPaciente(${p.id}, '${p.nombre.replace(/'/g, "\\'")}', '${p.rut}', ${p.edad}, '${p.diagnostico.replace(/'/g, "\\'")}', '${archivoImagen}')">✏️ Editar</button>
            <button class="btn btn-outline-danger btn-sm fw-semibold" onclick="eliminarPaciente(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')">🗑️ Egreso</button>
          </div>
        `;
      }

      container.innerHTML += `
        <div class="col-md-6">
          <div class="p-3 border rounded-4 bg-white d-flex flex-column justify-content-between h-100 shadow-sm">
            <div class="d-flex align-items-center justify-content-between gap-3">
              <div>
                <span class="badge-role-area d-inline-block mb-2" style="font-size:0.72rem;">Residente Activa</span>
                <h5 class="fw-bold mb-2 text-dark">📋 ${p.nombre}</h5>
                <p class="mb-1 text-secondary small"><strong>RUT:</strong> ${p.rut} &nbsp;|&nbsp; <span class="text-primary fw-bold">${p.edad} Años</span></p>
                <p class="mb-0 text-secondary small"><strong>Diagnóstico:</strong> <span class="text-danger fw-semibold">${p.diagnostico}</span></p>
              </div>
              <div class="text-center">
                <a href="${urlFicha}" target="_blank" title="Abrir ficha digital o escanear QR">
                  <img src="${qrUrl}" class="qr-img shadow-sm" alt="QR ${p.nombre}">
                </a>
                <div class="small text-primary fw-semibold mt-1">📱 Escanear QR</div>
              </div>
            </div>
            ${adminBtns}
          </div>
        </div>
      `;
    });
  } catch (error) {
    console.error('Error al cargar pacientes:', error);
  }
}

document.getElementById('form-agregar-paciente')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = document.getElementById('pac-nombre').value;
  const rut = document.getElementById('pac-rut').value;
  const edad = document.getElementById('pac-edad').value;
  const diagnostico = document.getElementById('pac-diag').value;
  const imagen_ficha = document.getElementById('pac-foto').value;

  const res = await fetch('/api/pacientes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, rut, edad, diagnostico, imagen_ficha })
  });

  const data = await res.json();
  if (data.success) {
    bootstrap.Modal.getInstance(document.getElementById('modalAgregarPaciente')).hide();
    document.getElementById('form-agregar-paciente').reset();
    cargarPacientes();
    mostrarToast('✅ Residente registrada correctamente.', 'success');
  }
});

function abrirModalEditarPaciente(id, nombre, rut, edad, diagnostico, imagen_ficha) {
  document.getElementById('edit-pac-id').value = id;
  document.getElementById('edit-pac-nombre').value = nombre;
  document.getElementById('edit-pac-rut').value = rut;
  document.getElementById('edit-pac-edad').value = edad;
  document.getElementById('edit-pac-diag').value = diagnostico;
  document.getElementById('edit-pac-foto').value = imagen_ficha || 'ficha1.png';

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEditarPaciente')).show();
}

document.getElementById('form-editar-paciente')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-pac-id').value;
  const nombre = document.getElementById('edit-pac-nombre').value;
  const rut = document.getElementById('edit-pac-rut').value;
  const edad = document.getElementById('edit-pac-edad').value;
  const diagnostico = document.getElementById('edit-pac-diag').value;
  const imagen_ficha = document.getElementById('edit-pac-foto').value;

  const res = await fetch(`/api/pacientes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, rut, edad, diagnostico, imagen_ficha })
  });

  const data = await res.json();
  if (data.success) {
    bootstrap.Modal.getInstance(document.getElementById('modalEditarPaciente')).hide();
    cargarPacientes();
    mostrarToast('✅ Datos de residente actualizados.', 'success');
  }
});

async function eliminarPaciente(id, nombre) {
  if (confirm(`¿Confirma el egreso y eliminación de "${nombre}" de la residencia?`)) {
    const res = await fetch(`/api/pacientes/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      cargarPacientes();
      mostrarToast('🗑️ Residente egresada del registro activo.', 'secondary');
    }
  }
}

// ============================================================================
// 7. SUPERVISIÓN, GESTIÓN DE USUARIOS (CREAR/ELIMINAR) Y ACTIVIDAD REMOTA EN VIVO
// ============================================================================
async function comprobarAlertasStockAdmin() {
  if (!permisos.supervision) return;
  try {
    const res = await fetch('/api/supervision/reorden');
    const data = await res.json();

    if (data.resumen.itemsEnAlerta > 0) {
      const tbody = document.getElementById('tabla-alerta-stock-body');
      if (!tbody) return;
      tbody.innerHTML = '';

      const itemsCriticos = data.detalles.filter(item => item.stock <= item.stock_minimo);

      itemsCriticos.forEach(item => {
        const unidad = esMedicamento(item) ? 'cajas' : 'unidades';
        const stockTexto = item.stock === 0 ? 'Agotado (0)' : `${item.stock} ${unidad}`;
        const badgeColor = item.stock === 0 ? 'bg-danger' : 'bg-warning text-dark';

        tbody.innerHTML += `
          <tr>
            <td class="fw-bold text-dark">${item.nombre} ${item.es_sos ? '<span class="badge bg-danger ms-1">SOS</span>' : ''}</td>
            <td><span class="badge ${badgeColor}">${stockTexto}</span></td>
            <td class="text-secondary">${item.stock_minimo} ${unidad}</td>
            <td class="fw-bold text-success">+${item.cantidad_a_pedir} ${unidad}</td>
            <td class="fw-bold text-danger">$${item.costo_total_estimado.toLocaleString('es-CL')} CLP</td>
          </tr>
        `;
      });

      document.getElementById('lbl-alerta-presupuesto').textContent = `$${data.resumen.presupuestoTotal.toLocaleString('es-CL')} CLP`;
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAlertaStock')).show();
    }
  } catch (error) {
    console.error('Error al comprobar alertas de stock:', error);
  }
}

async function cargarSupervision() {
  try {
    const res = await fetch('/api/supervision/reorden');
    const data = await res.json();
    cacheSupervision = data;

    document.getElementById('lbl-super-presupuesto').textContent = `$${data.resumen.presupuestoTotal.toLocaleString('es-CL')} CLP`;
    document.getElementById('lbl-super-gasto-consumo').textContent = `$${data.resumen.gastoTotalConsumo.toLocaleString('es-CL')} CLP`;
    document.getElementById('lbl-super-alertas').textContent = `${data.resumen.itemsEnAlerta} Productos`;

    const tbody = document.getElementById('tabla-supervision-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    data.detalles.forEach(item => {
      const badgePrio = item.prioridad === 'Alta' ? 'bg-danger' : item.prioridad === 'Media' ? 'bg-warning text-dark' : 'bg-secondary';
      const reordenTexto = item.cantidad_a_pedir > 0 ? `<span class="fw-bold text-danger">+${item.cantidad_a_pedir}</span>` : `<span class="text-success fw-semibold">OK (0)</span>`;

      tbody.innerHTML += `
        <tr>
          <td><span class="badge ${badgePrio}">${item.prioridad}</span></td>
          <td class="fw-bold text-dark">${item.nombre}</td>
          <td class="text-capitalize">${item.categoria}</td>
          <td><strong>${item.stock}</strong> / <span class="text-secondary">${item.stock_minimo}</span></td>
          <td class="text-primary fw-bold">${item.consumo_semanal}</td>
          <td class="fw-bold text-primary">$${item.costo_consumo_semanal.toLocaleString('es-CL')} CLP</td>
          <td>${reordenTexto}</td>
          <td class="fw-bold text-warning-emphasis">$${item.costo_total_estimado.toLocaleString('es-CL')} CLP</td>
        </tr>
      `;
    });

    cargarMensajesTens();
  } catch (error) {
    console.error('Error al cargar supervisión:', error);
  }
}

function descargarSupervisionCSV() {
  if (!cacheSupervision) return;
  const matriz = [
    ['Prioridad', 'Producto', 'Categoría', 'Stock Actual', 'Stock Mínimo', 'Consumo Semanal (7d)', 'Costo Consumido ($ CLP)', 'Sugerido Pedir', 'Precio Unitario ($ CLP)', 'Costo Reposición ($ CLP)']
  ];
  cacheSupervision.detalles.forEach(r => {
    matriz.push([
      r.prioridad,
      r.nombre,
      r.categoria.toUpperCase(),
      r.stock,
      r.stock_minimo,
      r.consumo_semanal,
      r.costo_consumo_semanal,
      r.cantidad_a_pedir,
      r.precio_unitario,
      r.costo_total_estimado
    ]);
  });
  matriz.push([]);
  matriz.push(['RESUMEN EJECUTIVO', 'Monto Total Consumido (A Cobrar)', cacheSupervision.resumen.gastoTotalConsumo, 'Presupuesto Reposición', cacheSupervision.resumen.presupuestoTotal]);
  const fecha = obtenerAhoraSantiago().fechaISO;
  descargarArchivoCSV(matriz, `Supervision_Clinica_Vital_${fecha}.csv`);
}

async function cargarUsuarios() {
  if (!permisos.supervision) return;
  try {
    const res = await fetch('/api/usuarios');
    const usuarios = await res.json();

    const tbody = document.getElementById('tabla-usuarios-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    usuarios.forEach(u => {
      const badgesPermisos = [];
      if (u.perm_medicamentos) badgesPermisos.push('<span class="badge bg-info-subtle text-info-emphasis border">💊 Fármacos</span>');
      if (u.perm_aseo) badgesPermisos.push('<span class="badge bg-success-subtle text-success-emphasis border">🧼 Aseo</span>');
      if (u.perm_pacientes) badgesPermisos.push('<span class="badge bg-primary-subtle text-primary border">📋 QR</span>');
      if (u.perm_editar_pacientes) badgesPermisos.push('<span class="badge bg-warning-subtle text-warning-emphasis border">✏️ Editar Pac.</span>');
      if (u.perm_agregar_stock) badgesPermisos.push('<span class="badge bg-secondary-subtle text-dark border">📦 Stock</span>');
      if (u.perm_supervision) badgesPermisos.push('<span class="badge bg-dark text-white">🛡️ Admin Total</span>');

      const temaLabel = u.tema_visual === 'admin' ? 'Azul Ejecutivo' : u.tema_visual === 'aa' ? 'Verde Menta' : 'Cian Clínico';

      const accionEliminar = u.es_sistema === 1
        ? '<span class="badge bg-light text-muted border">Cuenta Raíz</span>'
        : `<button class="btn btn-outline-danger btn-sm fw-semibold" onclick="eliminarUsuario(${u.id}, '${u.nombre_completo.replace(/'/g, "\\'")}')">🗑️ Revocar</button>`;

      tbody.innerHTML += `
        <tr>
          <td>
            <div class="fw-bold text-dark">${u.nombre_completo}</div>
            <small class="text-muted">Usuario: <code>${u.username}</code> · ${u.cargo}</small>
          </td>
          <td><span class="badge bg-light text-dark border">${temaLabel}</span></td>
          <td><div class="d-flex flex-wrap gap-1">${badgesPermisos.join(' ') || '<span class="text-muted">Sin áreas</span>'}</div></td>
          <td class="text-end">${accionEliminar}</td>
        </tr>
      `;
    });
  } catch (error) {
    console.error('Error al cargar usuarios:', error);
  }
}

document.getElementById('form-crear-usuario')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nombre_completo: document.getElementById('new-user-nombre').value,
    username: document.getElementById('new-user-username').value,
    password: document.getElementById('new-user-password').value,
    cargo: document.getElementById('new-user-cargo').value,
    tema_visual: document.getElementById('new-user-tema').value,
    perm_medicamentos: document.getElementById('perm-med').checked,
    perm_aseo: document.getElementById('perm-aseo').checked,
    perm_pacientes: document.getElementById('perm-pac').checked,
    perm_editar_pacientes: document.getElementById('perm-edit-pac').checked,
    perm_agregar_stock: document.getElementById('perm-stock').checked,
    perm_supervision: document.getElementById('perm-super').checked
  };

  try {
    const res = await fetch('/api/usuarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      if (document.getElementById('chk-crear-con-turno')?.checked) {
        const diasNuevo = Array.from(document.querySelectorAll('.chk-dia-nuevo-user:checked')).map(c => c.value);
        const temaSel = payload.tema_visual;
        const areaAuto = temaSel === 'aa' ? 'Aseo e Higiene' : temaSel === 'admin' ? 'Jefatura y Supervisión' : 'Enfermería y Fármacos';
        await fetch('/api/personal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nombre: payload.nombre_completo,
            rol: payload.cargo,
            area: areaAuto,
            horario: `${document.getElementById('new-user-horario-ini').value} - ${document.getElementById('new-user-horario-fin').value} hrs`,
            colacion: '13:30 - 14:30 hrs',
            dias: diasNuevo.length > 0 ? diasNuevo.join(', ') : 'Lunes, Miércoles, Viernes'
          })
        });
        await cargarPersonalTiempoReal();
      }

      document.getElementById('form-crear-usuario').reset();
      document.getElementById('perm-med').checked = true;
      document.getElementById('perm-pac').checked = true;
      document.getElementById('chk-crear-con-turno').checked = true;
      document.getElementById('bloque-turno-nuevo-usuario').style.display = 'block';
      cargarUsuarios();
      mostrarToast(`✅ Usuario "${payload.username}" creado y sincronizado con turnos.`, 'success');
    } else {
      alert(`⚠️ ${data.error || 'No se pudo crear el usuario.'}`);
    }
  } catch (error) {
    console.error('Error creando usuario:', error);
  }
});

async function eliminarUsuario(id, nombreCompleto) {
  if (confirm(`¿Desea eliminar y revocar inmediatamente el acceso de "${nombreCompleto}"?\nSu historial de consumos previos se mantendrá auditado en la base de datos.`)) {
    const res = await fetch(`/api/usuarios/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      cargarUsuarios();
      mostrarToast(`🔒 Acceso revocado para ${nombreCompleto}.`, 'warning');
    } else if (data.error) {
      alert(`⚠️ ${data.error}`);
    }
  }
}

async function cargarActividadReciente(notificarSiHayNuevo = true) {
  if (!permisos.supervision) return;
  try {
    const res = await fetch('/api/actividad/reciente');
    const logs = await res.json();
    const tbody = document.getElementById('tabla-actividad-remota-body');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">Aún no se registran movimientos en esta sesión.</td></tr>`;
      return;
    }

    const masReciente = logs[0];
    const nuevaFirma = `${masReciente.id || ''}|${masReciente.fecha_local}|${masReciente.usuario}|${masReciente.producto_nombre}|${masReciente.cantidad}`;
    const hayNuevoMovimiento = !primeraCargaActividad && firmaUltimaActividad !== null && firmaUltimaActividad !== nuevaFirma;

    if (hayNuevoMovimiento && notificarSiHayNuevo) {
      const horaChile = formatearFechaHoraSantiago24(masReciente.fecha_local);
      const esIngreso = masReciente.tipo_movimiento === 'ingreso' || masReciente.cantidad < 0;
      const cantAbs = Math.abs(masReciente.cantidad);
      if (esIngreso) {
        mostrarToast(`📦 Stock agregado en vivo: ${masReciente.usuario} sumó ${cantAbs} ${masReciente.producto_nombre} (${horaChile} hrs)`, 'success');
      } else {
        mostrarToast(`📡 Consumo en vivo: ${masReciente.usuario} descontó ${cantAbs} ${masReciente.producto_nombre} (${horaChile} hrs)`, 'info');
      }
    }

    firmaUltimaActividad = nuevaFirma;
    primeraCargaActividad = false;

    tbody.innerHTML = '';
    logs.forEach((l, idx) => {
      const unidad = l.categoria === 'medicamento' ? (Math.abs(l.cantidad) === 1 ? 'caja' : 'cajas') : (Math.abs(l.cantidad) === 1 ? 'unidad' : 'unidades');
      const fechaChile24 = formatearFechaHoraSantiago24(l.fecha_local);
      const claseFila = (idx === 0 && hayNuevoMovimiento) ? 'fila-nueva-highlight' : '';
      const esIngreso = l.tipo_movimiento === 'ingreso' || l.cantidad < 0;
      const cantAbs = Math.abs(l.cantidad);
      const badgeCantidad = esIngreso
        ? `<span class="badge bg-success-subtle text-success border border-success-subtle">+${cantAbs} ${unidad} (Reposición)</span>`
        : `<span class="badge bg-warning-subtle text-warning-emphasis border">-${cantAbs} ${unidad}</span>`;

      tbody.innerHTML += `
        <tr class="${claseFila}">
          <td class="text-secondary font-monospace fw-semibold">${fechaChile24} hrs</td>
          <td class="fw-bold text-primary">${l.usuario}</td>
          <td><span class="badge bg-light text-dark border text-capitalize">${l.categoria}</span></td>
          <td class="fw-semibold text-dark">${l.producto_nombre}</td>
          <td>${badgeCantidad}</td>
        </tr>
      `;
    });
  } catch (error) {
    console.error('Error cargando actividad remota:', error);
  }
}

async function cargarMensajesTens() {
  try {
    const res = await fetch('/api/mensajes');
    const mensajes = await res.json();

    const tbody = document.getElementById('tabla-mensajes-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (mensajes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No hay mensajes o sugerencias registradas.</td></tr>`;
      return;
    }

    mensajes.forEach(m => {
      const fechaChile24 = formatearFechaHoraSantiago24(m.fecha_local || m.fecha);
      tbody.innerHTML += `
        <tr>
          <td class="text-secondary font-monospace">${fechaChile24} hrs</td>
          <td><span class="badge bg-warning text-dark">${m.tipo}</span></td>
          <td class="text-dark">${m.mensaje}</td>
          <td class="text-primary fw-bold">${m.usuario}</td>
        </tr>
      `;
    });
  } catch (error) {
    console.error('Error al cargar mensajes:', error);
  }
}

document.getElementById('form-mensaje-tens')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tipo = document.getElementById('tens-msg-tipo').value;
  const mensaje = document.getElementById('tens-msg-texto').value;
  const st = obtenerAhoraSantiago();

  const res = await fetch('/api/mensajes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tipo,
      mensaje,
      usuario: `${userName} (${userCargo})`,
      fecha_chile: st.fechaHora24
    })
  });

  const data = await res.json();
  if (data.success) {
    document.getElementById('tens-msg-texto').value = '';
    bootstrap.Modal.getInstance(document.getElementById('modalMensajeTens')).hide();
    emitirEventoLocalRT('mensaje');
    mostrarToast('📩 Aviso enviado exitosamente a Jefatura.', 'success');
    if (permisos.supervision) cargarMensajesTens();
  }
});

// ============================================================================
// 8. CONSUMO SEMANAL Y REPOSICIÓN DE INVENTARIO
// ============================================================================
async function cargarReporteSemanal() {
  try {
    const res = await fetch('/api/consumo/semanal');
    const data = await res.json();
    cacheConsumo = data;

    const tbody = document.getElementById('tabla-reporte-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    document.getElementById('lbl-reporte-total-cobro').textContent = `$${data.gastoTotalSemanal.toLocaleString('es-CL')} CLP`;

    if (data.detalles.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No hay consumos registrados en los últimos 7 días.</td></tr>`;
      return;
    }

    data.detalles.forEach(h => {
      const unidad = h.categoria === 'medicamento' ? 'cajas' : 'unidades';
      const ultimaFecha24 = h.ultima_fecha ? `${formatearFechaHoraSantiago24(h.ultima_fecha)} hrs` : 'Reciente';
      tbody.innerHTML += `
        <tr>
          <td class="fw-bold text-dark">${h.producto_nombre}</td>
          <td><span class="badge bg-light text-dark border text-capitalize">${h.categoria}</span></td>
          <td><span class="badge bg-primary-subtle text-primary fw-bold">${h.usuario}</span></td>
          <td class="fw-bold text-warning-emphasis">${h.total_consumido} ${unidad}</td>
          <td>$${h.precio_unitario.toLocaleString('es-CL')} CLP</td>
          <td class="fw-bold text-primary">$${h.costo_total_consumo.toLocaleString('es-CL')} CLP</td>
          <td class="small text-secondary font-monospace">${ultimaFecha24}</td>
        </tr>
      `;
    });
  } catch (error) {
    console.error('Error al cargar reporte:', error);
  }
}

function descargarConsumoCSV() {
  if (!cacheConsumo) return;
  const matriz = [
    ['Producto', 'Categoría', 'Funcionario Responsable', 'Total Consumido Semanal', 'Precio Unitario ($ CLP)', 'Costo Consumido ($ CLP)', 'Última Fecha Registro (Santiago 24h)']
  ];
  if (cacheConsumo.detalles.length === 0) {
    matriz.push(['Sin registros', '-', '-', 0, 0, 0, '-']);
  } else {
    cacheConsumo.detalles.forEach(r => {
      matriz.push([
        r.producto_nombre,
        r.categoria.toUpperCase(),
        r.usuario,
        r.total_consumido,
        r.precio_unitario,
        r.costo_total_consumo,
        r.ultima_fecha ? formatearFechaHoraSantiago24(r.ultima_fecha) : ''
      ]);
    });
  }
  matriz.push([]);
  matriz.push(['MONTO TOTAL REAL CONSUMIDO A COBRAR ($ CLP)', cacheConsumo.gastoTotalSemanal]);
  const fecha = obtenerAhoraSantiago().fechaISO;
  descargarArchivoCSV(matriz, `Consumo_Semanal_Clinica_Vital_${fecha}.csv`);
}

function poblarSelects(itemsEnBD) {
  const selectMed = document.getElementById('med-select');
  const selectAseo = document.getElementById('aseo-select');
  if (!selectMed || !selectAseo) return;

  // Conservar lo que el usuario ya seleccionó para que el polling cada 1.5s no lo borre
  const valorMedPrevio = selectMed.value;
  const valorAseoPrevio = selectAseo.value;

  selectMed.innerHTML = '';
  const optDefaultMed = document.createElement('option');
  optDefaultMed.value = '';
  optDefaultMed.textContent = '-- Seleccionar medicamento --';
  selectMed.appendChild(optDefaultMed);

  itemsEnBD.filter(item => esMedicamento(item)).forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.nombre;
    opt.textContent = `${m.nombre} (Stock actual: ${m.stock} cajas)`;
    selectMed.appendChild(opt);
  });

  const optNuevoMed = document.createElement('option');
  optNuevoMed.value = '__NUEVO__';
  optNuevoMed.textContent = '➕ Registrar NUEVO medicamento...';
  selectMed.appendChild(optNuevoMed);

  if (valorMedPrevio) {
    selectMed.value = valorMedPrevio;
  }

  selectAseo.innerHTML = '';
  const optDefaultAseo = document.createElement('option');
  optDefaultAseo.value = '';
  optDefaultAseo.textContent = '-- Seleccionar artículo de aseo --';
  selectAseo.appendChild(optDefaultAseo);

  itemsEnBD.filter(item => !esMedicamento(item)).forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.nombre;
    opt.textContent = `${a.nombre} (Stock actual: ${a.stock} unidades)`;
    selectAseo.appendChild(opt);
  });

  const optNuevoAseo = document.createElement('option');
  optNuevoAseo.value = '__NUEVO__';
  optNuevoAseo.textContent = '➕ Registrar NUEVO artículo...';
  selectAseo.appendChild(optNuevoAseo);

  if (valorAseoPrevio) {
    selectAseo.value = valorAseoPrevio;
  }
}

document.getElementById('med-select')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const divNuevo = document.getElementById('div-med-nuevo');
  const inputNuevo = document.getElementById('med-nombre-nuevo');
  const esNuevo = val === '__NUEVO__';
  if (divNuevo) divNuevo.style.display = esNuevo ? 'block' : 'none';
  if (inputNuevo) {
    inputNuevo.required = esNuevo;
    if (!esNuevo) inputNuevo.value = '';
  }

  if (val && !esNuevo) {
    const prod = inventarioCache.find(i => i.nombre === val);
    if (prod) {
      if (prod.precio_unitario) document.getElementById('med-precio').value = prod.precio_unitario;
      if (prod.pauta) document.getElementById('med-pauta').value = prod.pauta;
    }
  }
});

document.getElementById('aseo-select')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const divNuevo = document.getElementById('div-aseo-nuevo');
  const inputNuevo = document.getElementById('aseo-nombre-nuevo');
  const esNuevo = val === '__NUEVO__';
  if (divNuevo) divNuevo.style.display = esNuevo ? 'block' : 'none';
  if (inputNuevo) {
    inputNuevo.required = esNuevo;
    if (!esNuevo) inputNuevo.value = '';
  }

  if (val && !esNuevo) {
    const prod = inventarioCache.find(i => i.nombre === val);
    if (prod) {
      if (prod.precio_unitario) document.getElementById('aseo-precio').value = prod.precio_unitario;
      if (prod.pauta) document.getElementById('aseo-pauta').value = prod.pauta;
    }
  }
});

document.getElementById('form-med')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const selectEl = document.getElementById('med-select');
  const selectVal = selectEl.value;
  const nombre = selectVal === '__NUEVO__' ? document.getElementById('med-nombre-nuevo').value.trim() : selectVal;
  if (!nombre) return;

  const cantidad = document.getElementById('med-cantidad').value;
  const precio_unitario = document.getElementById('med-precio').value;
  const pauta = document.getElementById('med-pauta').value;
  const responsableRegistro = `${userName} (${userCargo})`;
  const st = obtenerAhoraSantiago();

  const res = await fetch('/api/inventario/agregar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre,
      cantidad,
      categoria: 'medicamento',
      pauta,
      precio_unitario,
      usuario: responsableRegistro,
      fecha_chile: st.fechaHora24
    })
  });

  const data = await res.json();
  if (data.success) {
    selectEl.value = '';
    document.getElementById('med-nombre-nuevo').value = '';
    document.getElementById('div-med-nuevo').style.display = 'none';
    document.getElementById('med-cantidad').value = '1';
    bootstrap.Modal.getInstance(document.getElementById('modalAgregarMedicamento')).hide();
    emitirEventoLocalRT('stock');
    await sincronizarTodoEnVivo(true);
    mostrarToast(`💊 Stock actualizado: +${cantidad} ${nombre}`, 'success');
  }
});

document.getElementById('form-aseo')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const selectEl = document.getElementById('aseo-select');
  const selectVal = selectEl.value;
  const nombre = selectVal === '__NUEVO__' ? document.getElementById('aseo-nombre-nuevo').value.trim() : selectVal;
  if (!nombre) return;

  const cantidad = document.getElementById('aseo-cantidad').value;
  const precio_unitario = document.getElementById('aseo-precio').value;
  const pauta = document.getElementById('aseo-pauta').value;
  const responsableRegistro = `${userName} (${userCargo})`;
  const st = obtenerAhoraSantiago();

  const res = await fetch('/api/inventario/agregar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre,
      cantidad,
      categoria: 'aseo',
      pauta,
      precio_unitario,
      usuario: responsableRegistro,
      fecha_chile: st.fechaHora24
    })
  });

  const data = await res.json();
  if (data.success) {
    selectEl.value = '';
    document.getElementById('aseo-nombre-nuevo').value = '';
    document.getElementById('div-aseo-nuevo').style.display = 'none';
    document.getElementById('aseo-cantidad').value = '1';
    bootstrap.Modal.getInstance(document.getElementById('modalAgregarAseo')).hide();
    emitirEventoLocalRT('stock');
    await sincronizarTodoEnVivo(true);
    mostrarToast(`🧼 Stock actualizado: +${cantidad} ${nombre}`, 'success');
  }
});

document.getElementById('modalGestionTurno')?.addEventListener('hidden.bs.modal', () => {
  const modalSuper = document.getElementById('modalSupervision');
  if (modalSuper && modalSuper.classList.contains('show')) {
    document.body.classList.add('modal-open');
  }
});