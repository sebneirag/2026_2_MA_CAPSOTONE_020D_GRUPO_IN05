process.env.TZ = 'America/Santiago';

const express = require('express');
const path = require('path');
const fs = require('fs');

let sqlite3 = null;
let DatabaseSync = null;
let motorBD = 'sqlite3';

try {
  sqlite3 = require('sqlite3').verbose();
} catch (err) {
  ({ DatabaseSync } = require('node:sqlite'));
  motorBD = 'node:sqlite (integrado)';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// 1. MOTOR DE HORA OFICIAL SANTIAGO, CHILE (America/Santiago · ESCALA 24 HORAS)
// ============================================================================
const ZONA_HORARIA_CHILE = 'America/Santiago';

function obtenerAhoraChile(dateObj = new Date()) {
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

  const m = {};
  partes.forEach(p => { m[p.type] = p.value; });

  return {
    fechaCL: `${m.day}/${m.month}/${m.year}`,
    hora24: `${m.hour}:${m.minute}:${m.second}`,
    fechaHora24: `${m.day}/${m.month}/${m.year} ${m.hour}:${m.minute}:${m.second}`,
    fechaISO: `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`
  };
}

function normalizarFechaChile24(valor) {
  if (!valor) return obtenerAhoraChile().fechaHora24;
  const texto = String(valor).trim();

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(texto)) {
    const isoUtc = texto.replace(' ', 'T') + (texto.length === 16 ? ':00Z' : 'Z');
    const d = new Date(isoUtc);
    if (!isNaN(d.getTime())) {
      return obtenerAhoraChile(d).fechaHora24;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const d = new Date(texto);
    if (!isNaN(d.getTime())) {
      return obtenerAhoraChile(d).fechaHora24;
    }
  }

  const match = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?/i);
  if (match) {
    const dd = match[1].padStart(2, '0');
    const mm = match[2].padStart(2, '0');
    const yyyy = match[3];
    let hh = parseInt(match[4], 10);
    const min = match[5];
    const seg = match[6] || '00';
    const mer = (match[7] || '').toLowerCase().replace(/[\s\.]/g, '');

    if (mer === 'pm' && hh < 12) hh += 12;
    if (mer === 'am' && hh === 12) hh = 0;

    return `${dd}/${mm}/${yyyy} ${String(hh).padStart(2, '0')}:${min}:${seg}`;
  }

  return texto;
}

// ============================================================================
// 2. CANAL DE TRANSMISIÓN EN TIEMPO REAL (SERVER-SENT EVENTS - SSE)
// ============================================================================
const clientesSSE = new Set();

function emitirCambioTiempoReal(tipo = 'actualizacion', detalle = {}) {
  const payload = JSON.stringify({
    tipo,
    detalle,
    hora_santiago: obtenerAhoraChile().fechaHora24,
    ts: Date.now()
  });

  clientesSSE.forEach(res => {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      clientesSSE.delete(res);
    }
  });
}

setInterval(() => {
  clientesSSE.forEach(res => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clientesSSE.delete(res);
    }
  });
}, 25000);

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.write(`data: ${JSON.stringify({ tipo: 'conectado', hora_santiago: obtenerAhoraChile().fechaHora24 })}\n\n`);
  clientesSSE.add(res);

  req.on('close', () => {
    clientesSSE.delete(res);
  });
});

// ============================================================================
// 3. BASE DE DATOS SQLITE (SE CREA Y PUEBLA AUTOMÁTICAMENTE AL INICIAR)
// ============================================================================
const nombreArchivoBD = fs.existsSync(path.join(__dirname, 'database.db')) ? 'database.db' : 'clinica.db';
const rutaBD = path.join(__dirname, nombreArchivoBD);

const db = sqlite3 ? new sqlite3.Database(rutaBD) : null;
const dbNativa = !sqlite3 ? new DatabaseSync(rutaBD) : null;

function runAsync(sql, params = []) {
  if (db) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }
  return Promise.resolve(dbNativa.prepare(sql).run(...params));
}

function getAsync(sql, params = []) {
  if (db) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
  return Promise.resolve(dbNativa.prepare(sql).get(...params));
}

function allAsync(sql, params = []) {
  if (db) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
  return Promise.resolve(dbNativa.prepare(sql).all(...params));
}

async function inicializarBaseDatos() {
  await runAsync(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_completo TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      cargo TEXT DEFAULT 'Personal Clínico',
      tema_visual TEXT DEFAULT 'tens',
      perm_medicamentos INTEGER DEFAULT 1,
      perm_aseo INTEGER DEFAULT 0,
      perm_pacientes INTEGER DEFAULT 1,
      perm_editar_pacientes INTEGER DEFAULT 0,
      perm_agregar_stock INTEGER DEFAULT 0,
      perm_supervision INTEGER DEFAULT 0,
      es_sistema INTEGER DEFAULT 0
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS inventario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL,
      stock INTEGER DEFAULT 0,
      stock_minimo INTEGER DEFAULT 10,
      prioridad TEXT DEFAULT 'Media',
      pauta TEXT DEFAULT '',
      precio_unitario INTEGER DEFAULT 5000,
      es_sos INTEGER DEFAULT 0
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS consumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER,
      producto_nombre TEXT NOT NULL,
      categoria TEXT NOT NULL,
      cantidad INTEGER DEFAULT 1,
      precio_unitario INTEGER DEFAULT 0,
      usuario TEXT NOT NULL,
      fecha_local TEXT NOT NULL,
      fecha_iso TEXT NOT NULL
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS personal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL,
      area TEXT NOT NULL,
      horario TEXT NOT NULL,
      colacion TEXT NOT NULL,
      dias TEXT NOT NULL
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS pacientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      rut TEXT NOT NULL,
      edad INTEGER NOT NULL,
      diagnostico TEXT NOT NULL,
      imagen_ficha TEXT DEFAULT 'ficha1.png'
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      usuario TEXT NOT NULL,
      fecha_local TEXT NOT NULL
    )
  `);

  const alteraciones = [
    "ALTER TABLE usuarios ADD COLUMN nombre_completo TEXT DEFAULT ''",
    "ALTER TABLE usuarios ADD COLUMN cargo TEXT DEFAULT 'Personal Clínico'",
    "ALTER TABLE usuarios ADD COLUMN tema_visual TEXT DEFAULT 'tens'",
    "ALTER TABLE usuarios ADD COLUMN perm_medicamentos INTEGER DEFAULT 1",
    "ALTER TABLE usuarios ADD COLUMN perm_aseo INTEGER DEFAULT 0",
    "ALTER TABLE usuarios ADD COLUMN perm_pacientes INTEGER DEFAULT 1",
    "ALTER TABLE usuarios ADD COLUMN perm_editar_pacientes INTEGER DEFAULT 0",
    "ALTER TABLE usuarios ADD COLUMN perm_agregar_stock INTEGER DEFAULT 0",
    "ALTER TABLE usuarios ADD COLUMN perm_supervision INTEGER DEFAULT 0",
    "ALTER TABLE usuarios ADD COLUMN es_sistema INTEGER DEFAULT 0",
    "ALTER TABLE inventario ADD COLUMN prioridad TEXT DEFAULT 'Media'",
    "ALTER TABLE inventario ADD COLUMN precio_unitario INTEGER DEFAULT 5000",
    "ALTER TABLE inventario ADD COLUMN es_sos INTEGER DEFAULT 0",
    "ALTER TABLE consumos ADD COLUMN fecha_iso TEXT DEFAULT ''"
  ];

  for (const sql of alteraciones) {
    try {
      await runAsync(sql);
    } catch (e) {
      // Ignorar si la columna ya existe
    }
  }

  // 1. Cuentas base del sistema (admin / admin123, tens / tens123, AA / AA123)
  const totalUsuarios = await getAsync('SELECT COUNT(*) AS total FROM usuarios');
  if (!totalUsuarios || totalUsuarios.total === 0) {
    await runAsync(
      `INSERT INTO usuarios (nombre_completo, username, password, cargo, tema_visual, perm_medicamentos, perm_aseo, perm_pacientes, perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Dirección y Supervisión Clínica', 'admin', 'admin123', 'Administrador General', 'admin', 1, 1, 1, 1, 1, 1, 1]
    );
    await runAsync(
      `INSERT INTO usuarios (nombre_completo, username, password, cargo, tema_visual, perm_medicamentos, perm_aseo, perm_pacientes, perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Camila Rojas (TENS)', 'tens', 'tens123', 'TENS Enfermería', 'tens', 1, 0, 1, 0, 0, 0, 1]
    );
    await runAsync(
      `INSERT INTO usuarios (nombre_completo, username, password, cargo, tema_visual, perm_medicamentos, perm_aseo, perm_pacientes, perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['María José Soto (Auxiliar)', 'AA', 'AA123', 'Auxiliar de Aseo', 'aa', 0, 1, 0, 0, 0, 0, 1]
    );
  }

  // 2. Inventario inicial (Medicamentos base + SOS · Aseo exacto)
  const totalInv = await getAsync('SELECT COUNT(*) AS total FROM inventario');
  if (!totalInv || totalInv.total === 0) {
    const insumosIniciales = [
      // --- MEDICAMENTOS BASE ---
      ['Sertralina 50 mg (Caja 30 comp.)', 'medicamento', 15, 10, 'Alta', 'Mañana: 1 comp. post desayuno', 9800, 0],
      ['Fluoxetina 20 mg (Caja 30 comp.)', 'medicamento', 14, 10, 'Alta', 'Mañana: 1 comp. 08:30 hrs', 8500, 0],
      ['Quetiapina 25 mg (Caja 30 comp.)', 'medicamento', 14, 10, 'Alta', 'Noche: 1 comp. 21:00 hrs (inducción sueño)', 11200, 0],

      // --- MEDICAMENTOS SOS ---
      ['Clonazepam 0.5 mg (Caja 30 comp.)', 'medicamento', 14, 10, 'Alta', 'SOS: 1 comp. sublingual en crisis bajo indicación médica', 7900, 1],
      ['Lorazepam 1 mg (Caja 30 comp.)', 'medicamento', 12, 10, 'Alta', 'SOS: 1 comp. en episodio de agitación o angustia aguda', 8900, 1],
      ['Paracetamol 500 mg (Caja 20 comp.)', 'medicamento', 15, 10, 'Media', 'SOS: 1 comp. cada 8 hrs en caso de fiebre o cefalea', 2900, 1],
      ['Ibuprofeno 400 mg (Caja 20 comp.)', 'medicamento', 15, 10, 'Media', 'SOS: 1 comp. post comida en caso de dolor o inflamación', 3500, 1],

      // --- ARTÍCULOS DE ASEO (Prioridad Alta: 8-10 | Media: 6 | Baja: 4) ---
      ['Cloro Gel Desinfectante 5L', 'aseo', 10, 5, 'Alta', 'Desinfección de baños, pisos y áreas críticas', 6500, 0],
      ['Amonio Cuaternario 5L', 'aseo', 10, 5, 'Alta', 'Sanitización clínica profunda de habitaciones y salas', 12900, 0],
      ['Jabón Líquido Antibacterial 5L', 'aseo', 9, 5, 'Alta', 'Lavado clínico de manos en baños y estación enfermería', 7200, 0],
      ['Alcohol Gel Clínico 1L', 'aseo', 9, 5, 'Alta', 'Dispensadores de pasillos, accesos y enfermería', 4800, 0],
      ['Papel Higiénico Industrial (Pack)', 'aseo', 10, 5, 'Alta', 'Reposición diaria en baños de residentes y personal', 8900, 0],
      ['Toalla de Papel Interfoliada (Pack)', 'aseo', 8, 5, 'Alta', 'Secado de manos en dispensadores clínicos', 6400, 0],
      ['Guantes de Nitrilo Desechables (Caja)', 'aseo', 8, 5, 'Alta', 'Protección personal en procedimientos y limpieza', 5900, 0],
      ['Detergente Líquido Hipoalergénico 5L', 'aseo', 6, 3, 'Media', 'Lavado de ropa de cama y vestuario de residentes', 8500, 0],
      ['Lavaloza Concentrado 5L', 'aseo', 6, 3, 'Media', 'Higienización de utensilios de cocina y comedor', 5400, 0],
      ['Limpiavidrios y Multiuso 5L', 'aseo', 6, 3, 'Media', 'Limpieza de ventanales, espejos y mobiliario', 4900, 0],
      ['Desinfectante Ambiental en Aerosol', 'aseo', 6, 3, 'Media', 'Desinfección rápida de superficies y ambientes', 3800, 0],
      ['Bolsas de Basura Clínicas 80x110 (Rollo)', 'aseo', 4, 2, 'Baja', 'Retiro diario de residuos domiciliarios y clínicos', 3900, 0],
      ['Paños de Microfibra y Esponjas (Set)', 'aseo', 4, 2, 'Baja', 'Limpieza diferenciada por código de color', 3200, 0],
      ['Mopas / Traperos de Repuesto', 'aseo', 4, 2, 'Baja', 'Aseo húmedo diario de pasillos y habitaciones', 4500, 0]
    ];

    for (const item of insumosIniciales) {
      await runAsync(
        `INSERT INTO inventario (nombre, categoria, stock, stock_minimo, prioridad, pauta, precio_unitario, es_sos)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        item
      );
    }
  }

  // 3. Turnos base del personal
  const totalPersonal = await getAsync('SELECT COUNT(*) AS total FROM personal');
  if (!totalPersonal || totalPersonal.total === 0) {
    const turnosIniciales = [
      ['Camila Rojas (TENS)', 'TENS Enfermería Diurna', 'Enfermería y Fármacos', '08:00 - 20:00 hrs', '13:30 - 14:30 hrs', 'Lunes, Martes, Miércoles, Jueves, Viernes'],
      ['Valentina Paredes (TENS)', 'TENS Enfermería Relevo', 'Enfermería y Residencia', '08:00 - 20:00 hrs', '14:00 - 15:00 hrs', 'Sábado, Domingo'],
      ['María José Soto', 'Auxiliar de Aseo', 'Aseo e Higiene', '08:30 - 17:30 hrs', '13:00 - 14:00 hrs', 'Lunes, Martes, Miércoles, Jueves, Viernes, Sábado'],
      ['Dirección Clínica Vital', 'Supervisión General', 'Jefatura y Supervisión', '09:00 - 18:30 hrs', '13:30 - 14:30 hrs', 'Todos los días']
    ];

    for (const t of turnosIniciales) {
      await runAsync(
        `INSERT INTO personal (nombre, rol, area, horario, colacion, dias) VALUES (?, ?, ?, ?, ?, ?)`,
        t
      );
    }
  }

  // 4. Los 4 residentes iniciales (ficha1.png a ficha4.png)
  const totalPacientes = await getAsync('SELECT COUNT(*) AS total FROM pacientes');
  if (!totalPacientes || totalPacientes.total === 0) {
    const residentesIniciales = [
      ['Antonia Valdivia Muñoz', '21.845.320-4', 15, 'Trastorno Depresivo Mayor en Tratamiento', 'ficha1.png'],
      ['Isidora Carrasco Pérez', '22.104.892-K', 14, 'Trastorno de Ansiedad Generalizada', 'ficha2.png'],
      ['Valentina Morales Soto', '21.532.918-7', 16, 'Episodio Depresivo Severo en Seguimiento', 'ficha3.png'],
      ['Sofía Contreras Rojas', '22.419.605-2', 15, 'Trastorno Adaptativo Mixto en Tratamiento', 'ficha4.png']
    ];

    for (const r of residentesIniciales) {
      await runAsync(
        `INSERT INTO pacientes (nombre, rut, edad, diagnostico, imagen_ficha) VALUES (?, ?, ?, ?, ?)`,
        r
      );
    }
  }
}

// ============================================================================
// 4. RUTAS DE AUTENTICACIÓN Y GESTIÓN DE USUARIOS
// ============================================================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Ingrese usuario y contraseña.' });
    }

    const uClean = username.trim();
    const pClean = password.trim();

    let user = await getAsync(
      'SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?) AND password = ?',
      [uClean, pClean]
    );

    if (!user && uClean.toLowerCase() === 'aa' && (pClean.toLowerCase() === 'aa123' || pClean.toLowerCase() === 'aseo123')) {
      user = await getAsync("SELECT * FROM usuarios WHERE LOWER(username) = 'aa'");
    }

    if (!user) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' });
    }

    const esAdmin = Boolean(user.perm_supervision) || uClean.toLowerCase() === 'admin';
    const esAseo = Boolean(user.perm_aseo) || uClean.toLowerCase() === 'aa';

    res.json({
      success: true,
      username: (user.nombre_completo && user.nombre_completo.trim()) ? user.nombre_completo : user.username,
      userKey: user.username,
      role: esAdmin ? 'admin' : 'usuario',
      cargo: user.cargo || (esAdmin ? 'Administrador General' : (esAseo ? 'Auxiliar de Aseo' : 'Personal Clínico')),
      temaVisual: user.tema_visual || (esAdmin ? 'admin' : (esAseo ? 'aa' : 'tens')),
      permisos: {
        medicamentos: esAdmin ? true : Boolean(user.perm_medicamentos),
        aseo: esAdmin ? true : Boolean(esAseo),
        pacientes: esAdmin ? true : Boolean(user.perm_pacientes),
        editar_pacientes: esAdmin ? true : Boolean(user.perm_editar_pacientes),
        agregar_stock: esAdmin ? true : Boolean(user.perm_agregar_stock),
        supervision: esAdmin
      }
    });
  } catch (error) {
    console.error('Error en /api/login:', error);
    res.status(500).json({ success: false, error: 'Error interno al iniciar sesión.' });
  }
});

app.get('/api/usuarios', async (req, res) => {
  try {
    const rows = await allAsync(
      `SELECT id, nombre_completo, username, cargo, tema_visual,
              perm_medicamentos, perm_aseo, perm_pacientes,
              perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema
       FROM usuarios ORDER BY es_sistema DESC, id ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuarios.' });
  }
});

app.post('/api/usuarios', async (req, res) => {
  try {
    const {
      nombre_completo,
      username,
      password,
      cargo,
      tema_visual,
      perm_medicamentos,
      perm_aseo,
      perm_pacientes,
      perm_editar_pacientes,
      perm_agregar_stock,
      perm_supervision
    } = req.body;

    if (!nombre_completo || !username || !password) {
      return res.status(400).json({ success: false, error: 'Complete todos los campos obligatorios.' });
    }

    const existe = await getAsync('SELECT id FROM usuarios WHERE LOWER(username) = LOWER(?)', [username.trim()]);
    if (existe) {
      return res.status(400).json({ success: false, error: `El usuario "${username}" ya existe.` });
    }

    await runAsync(
      `INSERT INTO usuarios (
        nombre_completo, username, password, cargo, tema_visual,
        perm_medicamentos, perm_aseo, perm_pacientes,
        perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        nombre_completo.trim(),
        username.trim(),
        password.trim(),
        (cargo || 'Personal Clínico').trim(),
        tema_visual || 'tens',
        perm_medicamentos ? 1 : 0,
        perm_aseo ? 1 : 0,
        perm_pacientes ? 1 : 0,
        perm_editar_pacientes ? 1 : 0,
        perm_agregar_stock ? 1 : 0,
        perm_supervision ? 1 : 0
      ]
    );

    emitirCambioTiempoReal('usuario');
    res.json({ success: true });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ success: false, error: 'No se pudo crear el usuario.' });
  }
});

app.delete('/api/usuarios/:id', async (req, res) => {
  try {
    const user = await getAsync('SELECT es_sistema FROM usuarios WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado.' });
    }
    if (user.es_sistema === 1) {
      return res.status(403).json({ success: false, error: 'No se puede eliminar una cuenta raíz del sistema.' });
    }

    await runAsync('DELETE FROM usuarios WHERE id = ?', [req.params.id]);
    emitirCambioTiempoReal('usuario');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al eliminar usuario.' });
  }
});

// ============================================================================
// 5. RUTAS DE INVENTARIO Y CONSUMO EN TIEMPO REAL
// ============================================================================
app.get('/api/inventario', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventario ORDER BY id ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener inventario.' });
  }
});

app.post('/api/inventario/usar', async (req, res) => {
  try {
    const { id, cantidad = 1, usuario = 'Personal Clínico', fecha_chile } = req.body;
    const cant = parseInt(cantidad, 10) || 1;

    const item = await getAsync('SELECT * FROM inventario WHERE id = ?', [id]);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado.' });
    }

    if (item.stock < cant) {
      return res.status(400).json({ success: false, error: 'Stock insuficiente. Debe reponer este insumo.' });
    }

    const nuevoStock = item.stock - cant;
    const ahoraChile = obtenerAhoraChile();
    const fechaRegistro24 = fecha_chile ? normalizarFechaChile24(fecha_chile) : ahoraChile.fechaHora24;

    await runAsync('UPDATE inventario SET stock = ? WHERE id = ?', [nuevoStock, id]);

    await runAsync(
      `INSERT INTO consumos (producto_id, producto_nombre, categoria, cantidad, precio_unitario, usuario, fecha_local, fecha_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.id, item.nombre, item.categoria, cant, item.precio_unitario || 0, usuario, fechaRegistro24, ahoraChile.fechaISO]
    );

    emitirCambioTiempoReal('consumo', {
      producto: item.nombre,
      usuario,
      cantidad: cant,
      stockRestante: nuevoStock,
      fecha: fechaRegistro24
    });

    res.json({ success: true, stockRestante: nuevoStock, fecha: fechaRegistro24 });
  } catch (error) {
    console.error('Error al descontar inventario:', error);
    res.status(500).json({ success: false, error: 'Error al registrar el consumo.' });
  }
});

app.post('/api/inventario/agregar', async (req, res) => {
  try {
    const { nombre, cantidad, categoria, pauta, precio_unitario } = req.body;
    const cant = parseInt(cantidad, 10) || 1;
    const precio = parseInt(precio_unitario, 10) || 0;
    const cat = (categoria || 'medicamento').toLowerCase();

    const existente = await getAsync('SELECT * FROM inventario WHERE LOWER(nombre) = LOWER(?)', [nombre.trim()]);

    if (existente) {
      const nuevoStock = existente.stock + cant;
      await runAsync(
        `UPDATE inventario SET stock = ?, precio_unitario = ?, pauta = ? WHERE id = ?`,
        [nuevoStock, precio > 0 ? precio : existente.precio_unitario, pauta || existente.pauta, existente.id]
      );
    } else {
      const stockMin = cat === 'medicamento' ? 10 : 5;
      await runAsync(
        `INSERT INTO inventario (nombre, categoria, stock, stock_minimo, prioridad, pauta, precio_unitario, es_sos)
         VALUES (?, ?, ?, ?, 'Media', ?, ?, 0)`,
        [nombre.trim(), cat, cant, stockMin, pauta || 'Uso clínico general', precio]
      );
    }

    emitirCambioTiempoReal('stock', { nombre: nombre.trim(), cantidad: cant });
    res.json({ success: true });
  } catch (error) {
    console.error('Error agregando stock:', error);
    res.status(500).json({ success: false, error: 'Error al actualizar stock.' });
  }
});

// ============================================================================
// 6. SUPERVISIÓN, REORDEN, CONSUMO SEMANAL Y BITÁCORA EN TIEMPO REAL
// ============================================================================
app.get('/api/actividad/reciente', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM consumos ORDER BY id DESC LIMIT 50');
    const normalizados = rows.map(r => ({
      ...r,
      fecha_local: normalizarFechaChile24(r.fecha_local)
    }));
    res.json(normalizados);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener actividad reciente.' });
  }
});

app.get('/api/consumo/semanal', async (req, res) => {
  try {
    const hace7Dias = obtenerAhoraChile(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).fechaISO;

    const rows = await allAsync(
      `SELECT
         producto_nombre,
         categoria,
         usuario,
         SUM(cantidad) AS total_consumido,
         MAX(precio_unitario) AS precio_unitario,
         SUM(cantidad * precio_unitario) AS costo_total_consumo,
         MAX(fecha_local) AS ultima_fecha
       FROM consumos
       WHERE fecha_iso = '' OR fecha_iso >= ?
       GROUP BY producto_nombre, categoria, usuario
       ORDER BY MAX(id) DESC`,
      [hace7Dias]
    );

    const detalles = rows.map(r => ({
      ...r,
      ultima_fecha: normalizarFechaChile24(r.ultima_fecha)
    }));

    const gastoTotalSemanal = detalles.reduce((acc, r) => acc + (r.costo_total_consumo || 0), 0);

    res.json({ gastoTotalSemanal, detalles });
  } catch (error) {
    console.error('Error en /api/consumo/semanal:', error);
    res.status(500).json({ error: 'Error al calcular consumo semanal.' });
  }
});

app.get('/api/supervision/reorden', async (req, res) => {
  try {
    const hace7Dias = obtenerAhoraChile(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).fechaISO;
    const productos = await allAsync('SELECT * FROM inventario ORDER BY id ASC');
    const consumos7d = await allAsync(
      `SELECT producto_nombre, SUM(cantidad) AS total
       FROM consumos
       WHERE fecha_iso = '' OR fecha_iso >= ?
       GROUP BY producto_nombre`,
      [hace7Dias]
    );

    const mapaConsumo = {};
    consumos7d.forEach(c => {
      mapaConsumo[c.producto_nombre.toLowerCase()] = c.total || 0;
    });

    let presupuestoTotal = 0;
    let gastoTotalConsumo = 0;
    let itemsEnAlerta = 0;

    const detalles = productos.map(p => {
      const consumoSemanal = mapaConsumo[p.nombre.toLowerCase()] || 0;
      const precio = p.precio_unitario || 0;
      const costoConsumoSemanal = consumoSemanal * precio;
      const enAlerta = p.stock <= p.stock_minimo;

      if (enAlerta) itemsEnAlerta++;

      const stockOptimo = p.stock_minimo * 2;
      const cantidadAPedir = enAlerta ? Math.max(stockOptimo - p.stock, p.stock_minimo) : 0;
      const costoTotalEstimado = cantidadAPedir * precio;

      presupuestoTotal += costoTotalEstimado;
      gastoTotalConsumo += costoConsumoSemanal;

      return {
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria,
        stock: p.stock,
        stock_minimo: p.stock_minimo,
        prioridad: p.prioridad || 'Media',
        precio_unitario: precio,
        es_sos: p.es_sos || 0,
        consumo_semanal: consumoSemanal,
        costo_consumo_semanal: costoConsumoSemanal,
        cantidad_a_pedir: cantidadAPedir,
        costo_total_estimado: costoTotalEstimado
      };
    });

    res.json({
      resumen: {
        presupuestoTotal,
        gastoTotalConsumo,
        itemsEnAlerta
      },
      detalles
    });
  } catch (error) {
    console.error('Error en /api/supervision/reorden:', error);
    res.status(500).json({ error: 'Error al generar informe de supervisión.' });
  }
});

// ============================================================================
// 7. RUTAS DE TURNOS DEL PERSONAL
// ============================================================================
app.get('/api/personal', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM personal ORDER BY id ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al cargar turnos.' });
  }
});

app.post('/api/personal', async (req, res) => {
  try {
    const { nombre, rol, area, horario, colacion, dias } = req.body;
    await runAsync(
      'INSERT INTO personal (nombre, rol, area, horario, colacion, dias) VALUES (?, ?, ?, ?, ?, ?)',
      [nombre, rol, area, horario, colacion, dias]
    );
    emitirCambioTiempoReal('turno');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al crear turno.' });
  }
});

app.put('/api/personal/:id', async (req, res) => {
  try {
    const { nombre, rol, area, horario, colacion, dias } = req.body;
    await runAsync(
      'UPDATE personal SET nombre = ?, rol = ?, area = ?, horario = ?, colacion = ?, dias = ? WHERE id = ?',
      [nombre, rol, area, horario, colacion, dias, req.params.id]
    );
    emitirCambioTiempoReal('turno');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al actualizar turno.' });
  }
});

app.delete('/api/personal/:id', async (req, res) => {
  try {
    await runAsync('DELETE FROM personal WHERE id = ?', [req.params.id]);
    emitirCambioTiempoReal('turno');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al eliminar turno.' });
  }
});

// ============================================================================
// 8. RUTAS DE RESIDENTES Y FICHA DIGITAL QR (MÓVIL)
// ============================================================================
app.get('/api/pacientes', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM pacientes ORDER BY id ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al cargar residentes.' });
  }
});

app.post('/api/pacientes', async (req, res) => {
  try {
    const { nombre, rut, edad, diagnostico, imagen_ficha } = req.body;
    await runAsync(
      'INSERT INTO pacientes (nombre, rut, edad, diagnostico, imagen_ficha) VALUES (?, ?, ?, ?, ?)',
      [nombre, rut, parseInt(edad, 10) || 15, diagnostico, imagen_ficha || 'ficha1.png']
    );
    emitirCambioTiempoReal('paciente');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al registrar residente.' });
  }
});

app.put('/api/pacientes/:id', async (req, res) => {
  try {
    const { nombre, rut, edad, diagnostico, imagen_ficha } = req.body;
    await runAsync(
      'UPDATE pacientes SET nombre = ?, rut = ?, edad = ?, diagnostico = ?, imagen_ficha = ? WHERE id = ?',
      [nombre, rut, parseInt(edad, 10) || 15, diagnostico, imagen_ficha || 'ficha1.png', req.params.id]
    );
    emitirCambioTiempoReal('paciente');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al editar residente.' });
  }
});

app.delete('/api/pacientes/:id', async (req, res) => {
  try {
    await runAsync('DELETE FROM pacientes WHERE id = ?', [req.params.id]);
    emitirCambioTiempoReal('paciente');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al eliminar residente.' });
  }
});

app.get('/ficha/:id', async (req, res) => {
  try {
    const p = await getAsync('SELECT * FROM pacientes WHERE id = ?', [req.params.id]);
    if (!p) {
      return res.status(404).send('<h2>Ficha clínica no encontrada.</h2>');
    }

    const ahoraChile = obtenerAhoraChile().fechaHora24;
    const imgSrc = `/images/${p.imagen_ficha || 'ficha1.png'}`;

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Ficha Clínica - ${p.nombre}</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
      </head>
      <body class="bg-light p-3">
        <div class="container" style="max-width: 600px;">
          <div class="card border-0 shadow rounded-4 overflow-hidden">
            <div class="card-header bg-primary text-white p-3">
              <div class="d-flex justify-content-between align-items-center">
                <strong>🏥 Clínica Vital SpA · Ficha Digital</strong>
                <span class="badge bg-white text-primary font-monospace">${ahoraChile} hrs</span>
              </div>
            </div>
            <div class="card-body p-4">
              <h4 class="fw-bold text-dark mb-3">${p.nombre}</h4>
              <p class="mb-1"><strong>RUT:</strong> ${p.rut}</p>
              <p class="mb-1"><strong>Edad:</strong> ${p.edad} años</p>
              <p class="mb-3"><strong>Diagnóstico:</strong> <span class="text-danger fw-semibold">${p.diagnostico}</span></p>
              <div class="text-center border rounded-3 p-2 bg-white mb-3">
                <img src="${imgSrc}" alt="Ficha Clínica" class="img-fluid rounded" onerror="this.style.display='none'">
              </div>
              <div class="d-grid gap-2">
                <button class="btn btn-primary fw-bold" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Error al cargar ficha clínica.');
  }
});

// ============================================================================
// 9. RUTAS DE MENSAJES Y ALERTAS DEL PERSONAL A JEFATURA
// ============================================================================
app.get('/api/mensajes', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM mensajes ORDER BY id DESC LIMIT 40');
    const normalizados = rows.map(m => ({
      ...m,
      fecha_local: normalizarFechaChile24(m.fecha_local)
    }));
    res.json(normalizados);
  } catch (error) {
    res.status(500).json({ error: 'Error al cargar mensajes.' });
  }
});

app.post('/api/mensajes', async (req, res) => {
  try {
    const { tipo, mensaje, usuario, fecha_chile } = req.body;
    const fechaRegistro24 = fecha_chile ? normalizarFechaChile24(fecha_chile) : obtenerAhoraChile().fechaHora24;

    await runAsync(
      'INSERT INTO mensajes (tipo, mensaje, usuario, fecha_local) VALUES (?, ?, ?, ?)',
      [tipo, mensaje, usuario, fechaRegistro24]
    );

    emitirCambioTiempoReal('mensaje', { tipo, usuario });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al enviar mensaje.' });
  }
});

// ============================================================================
// 10. INICIO DEL SERVIDOR
// ============================================================================
inicializarBaseDatos()
  .then(() => {
    app.listen(PORT, () => {
      const st = obtenerAhoraChile();
      console.log(`✅ Servidor Clínica Vital SpA activo en http://localhost:${PORT}`);
      console.log(`🇨🇱 Hora Oficial Santiago, Chile (24h): ${st.fechaHora24} hrs`);
      console.log(`🗄️ Base de datos creada/conectada: ${nombreArchivoBD} (Motor: ${motorBD})`);
    });
  })
  .catch(err => {
    console.error('❌ Error al inicializar la base de datos:', err);
  });