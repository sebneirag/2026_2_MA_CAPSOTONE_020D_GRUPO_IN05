const express = require('express');
const path = require('path');
const os = require('os');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('virtual') || nameLower.includes('vbox') || nameLower.includes('vethernet') || nameLower.includes('docker') || nameLower.includes('wsl')) continue;
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIpAddress();

// ============================================================================
// CONEXIÓN DUAL A SQLITE (Render Cloud + Motor Nativo Node.js v26 Local)
// ============================================================================
let db;
try {
  const sqlite3 = require('sqlite3').verbose();
  db = new sqlite3.Database('./clinica_vital.db', (err) => {
    if (err) {
      console.error('Error SQLite:', err.message);
    } else {
      console.log('Base de datos clinica_vital.db conectada correctamente.');
      inicializarBD();
    }
  });
} catch (e) {
  const { DatabaseSync } = require('node:sqlite');
  const ndb = new DatabaseSync('./clinica_vital.db');
  db = {
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try {
        const info = ndb.prepare(sql).run(...(params || []));
        if (cb) cb.call({ lastID: Number(info.lastInsertRowid || 0), changes: Number(info.changes || 0) }, null);
      } catch (err) {
        if (cb) cb(err);
      }
    },
    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try {
        const row = ndb.prepare(sql).get(...(params || []));
        if (cb) cb(null, row);
      } catch (err) {
        if (cb) cb(err, null);
      }
    },
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try {
        const rows = ndb.prepare(sql).all(...(params || []));
        if (cb) cb(null, rows);
      } catch (err) {
        if (cb) cb(err, []);
      }
    },
    prepare(sql) {
      const stmt = ndb.prepare(sql);
      return {
        run(...args) {
          const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
          try {
            const info = stmt.run(...args);
            if (cb) cb.call({ lastID: Number(info.lastInsertRowid || 0) }, null);
          } catch (err) {
            if (cb) cb(err);
          }
        },
        finalize(cb) { if (cb) cb(null); }
      };
    }
  };
  console.log('Base de datos clinica_vital.db conectada (Motor Nativo Node 26).');
  setImmediate(inicializarBD);
}

function inicializarBD() {
  // 1. Tabla Usuarios y Permisos Granulares (Controlada por Administrador)
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nombre_completo TEXT NOT NULL,
      cargo TEXT NOT NULL,
      tema_visual TEXT NOT NULL DEFAULT 'tens',
      perm_medicamentos INTEGER DEFAULT 0,
      perm_aseo INTEGER DEFAULT 0,
      perm_pacientes INTEGER DEFAULT 0,
      perm_editar_pacientes INTEGER DEFAULT 0,
      perm_agregar_stock INTEGER DEFAULT 0,
      perm_supervision INTEGER DEFAULT 0,
      es_sistema INTEGER DEFAULT 0,
      fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    db.get('SELECT COUNT(*) as total FROM usuarios', (err, row) => {
      if (row && row.total === 0) {
        const stmt = db.prepare(`
          INSERT INTO usuarios 
          (username, password, nombre_completo, cargo, tema_visual, perm_medicamentos, perm_aseo, perm_pacientes, perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run('admin', 'admin123', 'Administrador General', 'Dirección y Supervisión', 'admin', 1, 1, 1, 1, 1, 1, 1);
        stmt.run('tens', 'tens123', 'TENS 1 (Enfermería)', 'TENS de Turno Clínico', 'tens', 1, 0, 1, 0, 0, 0, 0);
        stmt.run('AA', 'AA123', 'TENS AA (Aseo y Apoyo)', 'Auxiliar de Aseo y Apoyo', 'aa', 0, 1, 0, 0, 0, 0, 0);
        stmt.finalize();
        console.log('Usuarios iniciales creados en base de datos.');
      }
    });
  });

  // 2. Tabla Inventario
  db.run(`
    CREATE TABLE IF NOT EXISTS inventario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      categoria TEXT NOT NULL,
      pauta TEXT,
      precio_unitario REAL DEFAULT 0,
      stock_minimo INTEGER DEFAULT 10,
      stock_maximo INTEGER DEFAULT 20,
      prioridad TEXT DEFAULT 'Media',
      es_sos INTEGER DEFAULT 0
    )
  `, () => {
    db.get('SELECT COUNT(*) as total FROM inventario', (err, row) => {
      if (row && row.total === 0) {
        const stmt = db.prepare(`
          INSERT INTO inventario 
          (nombre, stock, categoria, pauta, precio_unitario, stock_minimo, stock_maximo, prioridad, es_sos) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run('Sertralina 50mg', 15, 'medicamento', 'Mañana: 1, Tarde: 0, Noche: 1 (sueño), SOS: 1', 8500, 10, 20, 'Media', 0);
        stmt.run('Fluoxetina 20mg', 15, 'medicamento', 'Mañana: 1, Tarde: 1, Noche: 0, SOS: 0', 7200, 10, 20, 'Media', 0);
        stmt.run('Clonazepam 2mg (SOS)', 15, 'medicamento', 'Mañana: 0, Tarde: 0, Noche: 1 (sueño), SOS: 1 (Crisis)', 12000, 10, 25, 'Alta', 1);
        stmt.run('Quetiapina 100mg (SOS)', 15, 'medicamento', 'Mañana: 0, Tarde: 0, Noche: 1 (sueño), SOS: 1 (Crisis)', 15500, 10, 25, 'Alta', 1);
        stmt.run('Escitalopram 10mg', 15, 'medicamento', 'Mañana: 1, Tarde: 0, Noche: 0, SOS: 0', 9800, 10, 20, 'Media', 0);

        stmt.run('Cloro Concentrado 5L', 15, 'aseo', 'Desinfección general e higienización', 4500, 10, 20, 'Alta', 0);
        stmt.run('Detergente Clínico Multiuso', 14, 'aseo', 'Lavado de ropa de cama y uniformes', 8900, 8, 18, 'Alta', 0);
        stmt.run('Clorhexidina Jabón 1L', 14, 'aseo', 'Higiene antiséptica de personal y residentes', 11000, 8, 18, 'Alta', 0);
        stmt.run('Bolsas Basura Amarillas (Residuos)', 15, 'aseo', 'Gestión de residuos clínicos', 6000, 6, 15, 'Media', 0);
        stmt.run('Jabón Antiséptico 1L', 13, 'aseo', 'Higiene de manos y sanitización', 5500, 6, 15, 'Media', 0);
        stmt.run('Toallas de Papel (Paquete 8 rollos)', 13, 'aseo', 'Secado e higiene rápida', 4200, 4, 12, 'Baja', 0);

        stmt.finalize();
      }
    });
  });

  // 3. Tabla Personal y Turnos
  db.run(`
    CREATE TABLE IF NOT EXISTS personal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL,
      area TEXT NOT NULL,
      horario TEXT NOT NULL,
      colacion TEXT NOT NULL,
      dias TEXT NOT NULL,
      estado TEXT DEFAULT 'En Turno'
    )
  `, () => {
    db.get('SELECT COUNT(*) as total FROM personal', (err, row) => {
      if (row && row.total === 0) {
        const stmt = db.prepare('INSERT INTO personal (nombre, rol, area, horario, colacion, dias, estado) VALUES (?, ?, ?, ?, ?, ?, ?)');
        stmt.run('María González Tapia', 'TENS de Turno', 'Enfermería y Fármacos', '08:00 - 20:00 hrs', '13:30 - 14:30 hrs', 'Lunes, Miércoles, Viernes, Domingo', 'En Turno');
        stmt.run('Camila Valenzuela P.', 'TENS de Apoyo', 'Enfermería y Residencia', '08:00 - 20:00 hrs', '14:30 - 15:30 hrs', 'Martes, Jueves, Sábado', 'En Turno');
        stmt.run('Juan Pérez Morales', 'Auxiliar de Aseo', 'Aseo e Higiene', '07:30 - 16:30 hrs', '12:30 - 13:30 hrs', 'Lunes, Martes, Miércoles, Jueves, Viernes', 'En Turno');
        stmt.run('Rosa Espinoza Soto', 'Cocinera Principal', 'Cocina y Nutrición', '07:00 - 16:00 hrs', '12:00 - 13:00 hrs', 'Todos los días', 'En Turno');
        stmt.run('Dr. Carlos Silva R.', 'Jefe de Turno', 'Jefatura y Supervisión', '08:00 - 18:00 hrs', '14:00 - 15:00 hrs', 'Lunes, Martes, Miércoles, Jueves, Viernes', 'En Turno');
        stmt.finalize();
      }
    });
  });

  // 4. Tabla Historial de Consumo
  db.run(`
    CREATE TABLE IF NOT EXISTS historial_consumo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_nombre TEXT NOT NULL,
      categoria TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      usuario TEXT NOT NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5. Tabla Mensajes TENS
  db.run(`
    CREATE TABLE IF NOT EXISTS mensajes_tens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      usuario TEXT NOT NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      leido INTEGER DEFAULT 0
    )
  `);

  // 6. Tabla Pacientes
  db.run(`
    CREATE TABLE IF NOT EXISTS pacientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      rut TEXT NOT NULL,
      edad INTEGER NOT NULL,
      diagnostico TEXT NOT NULL,
      imagen_ficha TEXT DEFAULT 'ficha1.png',
      fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    db.run("ALTER TABLE pacientes ADD COLUMN imagen_ficha TEXT DEFAULT 'ficha1.png'", () => {});

    db.get('SELECT COUNT(*) as total FROM pacientes', (err, row) => {
      if (row && row.total === 0) {
        const stmt = db.prepare('INSERT INTO pacientes (nombre, rut, edad, diagnostico, imagen_ficha) VALUES (?, ?, ?, ?, ?)');
        stmt.run('Camila Soto Morales', '18.452.120-K', 16, 'Trastorno Depresivo Mayor', 'ficha1.png');
        stmt.run('Valentina Morales Rojas', '19.821.433-2', 17, 'Trastorno Bipolar T-1', 'ficha2.png');
        stmt.run('Sofía Henríquez Silva', '20.123.456-7', 15, 'Trastorno Ansioso Depresivo', 'ficha3.png');
        stmt.run('Isidora Tapia Fuentes', '21.987.654-3', 16, 'Trastorno Adaptativo Severo', 'ficha4.png');
        stmt.finalize();
        console.log('4 Pacientes iniciales creadas en base de datos.');
      }
    });
  });
}

// Configuración IP
app.get('/api/config', (req, res) => {
  res.json({ ip: LOCAL_IP, port: PORT });
});

// ============================================================================
// AUTENTICACIÓN Y GESTIÓN DE USUARIOS / PERMISOS POR ADMINISTRADOR
// ============================================================================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Ingrese usuario y contraseña.' });
  }

  db.get(
    'SELECT * FROM usuarios WHERE LOWER(TRIM(username)) = LOWER(TRIM(?)) AND password = ?',
    [username, password],
    (err, user) => {
      if (err) return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
      if (!user) {
        return res.status(401).json({ success: false, message: 'Credenciales incorrectas o usuario revocado.' });
      }

      const roleGeneral = user.perm_supervision === 1 ? 'admin' : 'usuario';
      res.json({
        success: true,
        id: user.id,
        role: roleGeneral,
        userKey: user.username,
        nombreUsuario: user.nombre_completo,
        cargo: user.cargo,
        temaVisual: user.tema_visual || 'tens',
        permisos: {
          medicamentos: user.perm_medicamentos === 1,
          aseo: user.perm_aseo === 1,
          pacientes: user.perm_pacientes === 1,
          editar_pacientes: user.perm_editar_pacientes === 1,
          agregar_stock: user.perm_agregar_stock === 1,
          supervision: user.perm_supervision === 1
        }
      });
    }
  );
});

app.get('/api/usuarios', (req, res) => {
  db.all(
    `SELECT id, username, nombre_completo, cargo, tema_visual,
            perm_medicamentos, perm_aseo, perm_pacientes,
            perm_editar_pacientes, perm_agregar_stock, perm_supervision,
            es_sistema, datetime(fecha_creacion, 'localtime') as fecha_creacion
     FROM usuarios ORDER BY es_sistema DESC, id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/usuarios', (req, res) => {
  const {
    username,
    password,
    nombre_completo,
    cargo,
    tema_visual,
    perm_medicamentos,
    perm_aseo,
    perm_pacientes,
    perm_editar_pacientes,
    perm_agregar_stock,
    perm_supervision
  } = req.body;

  if (!username || !password || !nombre_completo) {
    return res.status(400).json({ error: 'Usuario, contraseña y nombre completo son obligatorios.' });
  }

  const userClean = username.trim();
  const temaClean = ['admin', 'tens', 'aa'].includes(tema_visual) ? tema_visual : 'tens';

  db.get('SELECT id FROM usuarios WHERE LOWER(TRIM(username)) = LOWER(?)', [userClean], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (existing) {
      return res.status(400).json({ error: `El nombre de usuario "${userClean}" ya existe en el sistema.` });
    }

    db.run(
      `INSERT INTO usuarios 
       (username, password, nombre_completo, cargo, tema_visual, perm_medicamentos, perm_aseo, perm_pacientes, perm_editar_pacientes, perm_agregar_stock, perm_supervision, es_sistema)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        userClean,
        password.trim(),
        nombre_completo.trim(),
        (cargo || 'Personal Clínico').trim(),
        temaClean,
        perm_medicamentos ? 1 : 0,
        perm_aseo ? 1 : 0,
        perm_pacientes ? 1 : 0,
        perm_editar_pacientes ? 1 : 0,
        perm_agregar_stock ? 1 : 0,
        perm_supervision ? 1 : 0
      ],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

app.delete('/api/usuarios/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM usuarios WHERE id = ?', [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (user.es_sistema === 1) {
      return res.status(403).json({ error: 'No se puede eliminar la cuenta raíz de Administrador del sistema.' });
    }

    db.run('DELETE FROM usuarios WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// ============================================================================
// APIs PACIENTES (CRUD) Y VISTA MÓVIL QR (/ficha/:id)
// ============================================================================
app.get('/api/pacientes', (req, res) => {
  db.all('SELECT * FROM pacientes ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/pacientes', (req, res) => {
  const { nombre, rut, edad, diagnostico, imagen_ficha } = req.body;
  if (!nombre || !rut || !edad) {
    return res.status(400).json({ error: 'Faltan datos obligatorios del residente.' });
  }

  const imgFinal = (imagen_ficha && imagen_ficha.trim()) ? imagen_ficha.trim() : 'ficha1.png';

  db.run(
    'INSERT INTO pacientes (nombre, rut, edad, diagnostico, imagen_ficha) VALUES (?, ?, ?, ?, ?)',
    [nombre.trim(), rut.trim(), parseInt(edad, 10), (diagnostico || 'Evaluación General').trim(), imgFinal],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/pacientes/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, rut, edad, diagnostico, imagen_ficha } = req.body;
  const imgFinal = (imagen_ficha && imagen_ficha.trim()) ? imagen_ficha.trim() : 'ficha1.png';

  db.run(
    'UPDATE pacientes SET nombre = ?, rut = ?, edad = ?, diagnostico = ?, imagen_ficha = ? WHERE id = ?',
    [nombre.trim(), rut.trim(), parseInt(edad, 10), (diagnostico || 'Evaluación General').trim(), imgFinal, id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/pacientes/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM pacientes WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/ficha/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM pacientes WHERE id = ?', [id], (err, paciente) => {
    if (err || !paciente) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Ficha No Encontrada - Clínica Vital SpA</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        </head><body style="background:#f8fafc;color:#0f172a;" class="d-flex align-items-center justify-content-center min-vh-100 p-4">
          <div class="bg-white border rounded-4 shadow-sm p-5 text-center" style="max-width:480px;">
            <div class="fs-1 mb-2">⚠️</div>
            <h3 class="fw-bold text-danger">Ficha Clínica No Encontrada</h3>
            <p class="text-secondary mb-0">El código QR escaneado no pertenece a una residente activa o ha sido dada de alta del sistema.</p>
          </div>
        </body></html>
      `);
    }

    const archivoImagen = paciente.imagen_ficha ? paciente.imagen_ficha : 'ficha1.png';
    const rutaImagen = `/images/${archivoImagen}`;

    const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Ficha Clínica Digital - ${paciente.nombre}</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
          body { background: linear-gradient(135deg, #f0f9ff 0%, #f8fafc 100%); color: #0f172a; padding: 16px; font-family: system-ui, -apple-system, sans-serif; }
          .card-ficha { background-color: #ffffff; border: 1px solid #e2e8f0; border-top: 5px solid #0284c7; border-radius: 18px; padding: 24px; margin: 0 auto; max-width: 680px; }
          .badge-clinica { background-color: #e0f2fe; color: #0369a1; font-size: 0.82rem; padding: 6px 14px; border-radius: 20px; font-weight: 700; border: 1px solid #bae6fd; }
          .data-strip { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; }
          .img-ficha { width: 100%; border-radius: 12px; border: 1px solid #cbd5e1; background-color: #ffffff; }
        </style>
      </head>
      <body>
        <div class="container my-2">
          <div class="card-ficha shadow-sm">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
              <span class="badge-clinica">🏥 CLÍNICA VITAL SpA — FICHA CLÍNICA DIGITAL</span>
              <span class="badge bg-success-subtle text-success border border-success-subtle px-3 py-2 rounded-pill">● Residente Activa</span>
            </div>

            <h3 class="fw-bold text-dark mb-2">${paciente.nombre}</h3>
            <div class="data-strip mb-3 d-flex flex-wrap gap-3 small">
              <div><span class="text-secondary">RUT:</span> <strong class="text-dark">${paciente.rut}</strong></div>
              <div><span class="text-secondary">Edad:</span> <strong class="text-primary">${paciente.edad} Años</strong></div>
              <div><span class="text-secondary">Diagnóstico:</span> <strong class="text-danger">${paciente.diagnostico}</strong></div>
            </div>

            <div class="mb-4 text-center">
              <img src="${rutaImagen}" onerror="this.src='/images/ficha1.png'" class="img-ficha shadow-sm" alt="Ficha Clínica de ${paciente.nombre}">
            </div>

            <div class="row g-2">
              <div class="col-6">
                <a href="${rutaImagen}" download="${paciente.nombre.replace(/\s+/g, '_')}_Ficha.png" class="btn btn-primary w-100 fw-bold py-2 shadow-sm">
                  📥 Descargar Ficha
                </a>
              </div>
              <div class="col-6">
                <a href="${rutaImagen}" target="_blank" class="btn btn-outline-primary w-100 fw-bold py-2">
                  🔍 Ver Imagen HD
                </a>
              </div>
            </div>

            <div class="mt-2 text-center">
              <button onclick="window.print()" class="btn btn-light border text-secondary btn-sm w-100 py-2">🖨️ Imprimir Documento Clínico</button>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
    res.send(html);
  });
});

// ============================================================================
// APIs INVENTARIO, SUPERVISIÓN, REPORTES Y MONITOREO REMOTO EN TIEMPO REAL
// ============================================================================
app.get('/api/inventario', (req, res) => {
  db.all('SELECT * FROM inventario ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/inventario/usar', (req, res) => {
  const { id, cantidad, usuario } = req.body;
  const cantNum = parseInt(cantidad, 10) || 1;
  const user = usuario || 'Usuario TENS';

  db.get('SELECT * FROM inventario WHERE id = ?', [id], (err, producto) => {
    if (err || !producto) return res.status(404).json({ error: 'Producto no encontrado' });

    if (producto.stock <= 0 || producto.stock < cantNum) {
      return res.status(400).json({ error: 'Debe reponer stock. El producto se encuentra agotado.' });
    }

    db.run('UPDATE inventario SET stock = stock - ? WHERE id = ?', [cantNum, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        'INSERT INTO historial_consumo (producto_nombre, categoria, cantidad, usuario) VALUES (?, ?, ?, ?)',
        [producto.nombre.trim(), producto.categoria, cantNum, user],
        () => res.json({ success: true, stockRestante: producto.stock - cantNum })
      );
    });
  });
});

app.post('/api/inventario/agregar', (req, res) => {
  const { nombre, cantidad, categoria, pauta, precio_unitario, stock_minimo, stock_maximo, prioridad, es_sos } = req.body;
  const nomLimpio = (nombre || '').trim();
  const cantNum = parseInt(cantidad, 10) || 1;
  const precio = parseFloat(precio_unitario) || 5000;
  
  const defaultMin = categoria === 'medicamento' ? 10 : (prioridad === 'Alta' ? 8 : prioridad === 'Media' ? 6 : 4);
  const defaultMax = categoria === 'medicamento' ? 20 : 15;
  const minStock = parseInt(stock_minimo, 10) || defaultMin;
  const maxStock = parseInt(stock_maximo, 10) || defaultMax;

  db.get('SELECT * FROM inventario WHERE LOWER(TRIM(nombre)) = LOWER(?)', [nomLimpio], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    if (row) {
      db.run(
        `UPDATE inventario SET stock = stock + ?, pauta = CASE WHEN ? != "" THEN ? ELSE pauta END, precio_unitario = CASE WHEN ? > 0 THEN ? ELSE precio_unitario END WHERE id = ?`,
        [cantNum, (pauta || '').trim(), (pauta || '').trim(), precio, precio, row.id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, action: 'updated' });
        }
      );
    } else {
      db.run(
        `INSERT INTO inventario (nombre, stock, categoria, pauta, precio_unitario, stock_minimo, stock_maximo, prioridad, es_sos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nomLimpio, cantNum, categoria, pauta || 'N/A', precio, minStock, maxStock, prioridad || 'Media', es_sos ? 1 : 0],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, action: 'inserted', id: this.lastID });
        }
      );
    }
  });
});

app.get('/api/supervision/reorden', (req, res) => {
  const sql = `
    SELECT 
      i.*,
      COALESCE(c.total_consumido, 0) AS consumo_semanal,
      (COALESCE(c.total_consumido, 0) * i.precio_unitario) AS costo_consumo_semanal,
      CASE WHEN i.stock <= i.stock_minimo THEN (i.stock_maximo - i.stock) ELSE 0 END AS cantidad_a_pedir,
      CASE WHEN i.stock <= i.stock_minimo THEN ((i.stock_maximo - i.stock) * i.precio_unitario) ELSE 0 END AS costo_total_estimado
    FROM inventario i
    LEFT JOIN (
      SELECT LOWER(TRIM(producto_nombre)) as nom, SUM(cantidad) as total_consumido
      FROM historial_consumo WHERE fecha >= datetime('now', '-7 days')
      GROUP BY LOWER(TRIM(producto_nombre))
    ) c ON LOWER(TRIM(i.nombre)) = c.nom
    ORDER BY CASE i.prioridad WHEN 'Alta' THEN 1 WHEN 'Media' THEN 2 ELSE 3 END, (i.stock <= i.stock_minimo) DESC, i.nombre ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    let presupuestoTotal = 0;
    let gastoTotalConsumo = 0;
    let itemsEnAlerta = 0;

    rows.forEach(r => {
      presupuestoTotal += r.costo_total_estimado;
      gastoTotalConsumo += r.costo_consumo_semanal;
      if (r.stock <= r.stock_minimo) itemsEnAlerta++;
    });

    res.json({ resumen: { presupuestoTotal, gastoTotalConsumo, itemsEnAlerta, totalProductos: rows.length }, detalles: rows });
  });
});

app.get('/api/consumo/semanal', (req, res) => {
  const sql = `
    SELECT 
       hc.producto_nombre, hc.categoria, hc.usuario, SUM(hc.cantidad) as total_consumido, 
       MAX(datetime(hc.fecha, 'localtime')) as ultima_fecha, COALESCE(i.precio_unitario, 0) as precio_unitario,
       (SUM(hc.cantidad) * COALESCE(i.precio_unitario, 0)) as costo_total_consumo
     FROM historial_consumo hc
     LEFT JOIN inventario i ON LOWER(TRIM(hc.producto_nombre)) = LOWER(TRIM(i.nombre))
     WHERE hc.fecha >= datetime('now', '-7 days') 
     GROUP BY LOWER(TRIM(hc.producto_nombre)), hc.categoria, hc.usuario
     ORDER BY total_consumido DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let gastoTotalSemanal = 0;
    rows.forEach(r => { gastoTotalSemanal += r.costo_total_consumo; });
    res.json({ gastoTotalSemanal, detalles: rows });
  });
});

app.get('/api/actividad/reciente', (req, res) => {
  const sql = `
    SELECT id, producto_nombre, categoria, cantidad, usuario, datetime(fecha, 'localtime') as fecha_local
    FROM historial_consumo
    ORDER BY id DESC
    LIMIT 15
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/mensajes', (req, res) => {
  const { tipo, mensaje, usuario } = req.body;
  if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

  db.run(
    'INSERT INTO mensajes_tens (tipo, mensaje, usuario) VALUES (?, ?, ?)',
    [tipo || 'Falta Stock / Sugerencia', mensaje.trim(), usuario || 'Personal TENS'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.get('/api/mensajes', (req, res) => {
  db.all('SELECT *, datetime(fecha, "localtime") as fecha_local FROM mensajes_tens ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ============================================================================
// APIs GESTIÓN DE TURNOS EN TIEMPO REAL (CREAR, EDITAR, ELIMINAR)
// ============================================================================
app.get('/api/personal', (req, res) => {
  db.all('SELECT * FROM personal ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/personal', (req, res) => {
  const { nombre, rol, area, horario, colacion, dias } = req.body;
  if (!nombre || !rol || !horario || !dias) {
    return res.status(400).json({ error: 'Nombre, cargo, horario y días son obligatorios.' });
  }

  db.run(
    'INSERT INTO personal (nombre, rol, area, horario, colacion, dias, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      nombre.trim(),
      rol.trim(),
      (area || 'Enfermería y Fármacos').trim(),
      horario.trim(),
      (colacion || '13:30 - 14:30 hrs').trim(),
      dias.trim(),
      'En Turno'
    ],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/personal/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, rol, area, horario, colacion, dias } = req.body;
  if (!nombre || !rol || !horario || !dias) {
    return res.status(400).json({ error: 'Complete todos los campos del turno.' });
  }

  db.run(
    'UPDATE personal SET nombre = ?, rol = ?, area = ?, horario = ?, colacion = ?, dias = ? WHERE id = ?',
    [
      nombre.trim(),
      rol.trim(),
      (area || 'Enfermería y Fármacos').trim(),
      horario.trim(),
      (colacion || '13:30 - 14:30 hrs').trim(),
      dias.trim(),
      id
    ],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/personal/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM personal WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Clínica Vital activo en: http://localhost:${PORT}/login.html`);
});