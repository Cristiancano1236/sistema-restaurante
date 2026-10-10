require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const app = express();
const db = require('./db');
const session = require('express-session');
const { attachUserToLocals, requireAuth, requireRole } = require('./middleware/auth');

// Crear directorios necesarios
const createRequiredDirectories = () => {
    const directories = [
        path.join(__dirname, 'public'),
        path.join(__dirname, 'public', 'uploads'),
        path.join(__dirname, 'public', 'css'),
        path.join(__dirname, 'public', 'js')
    ];

    directories.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Directorio creado: ${dir}`);
        }
    });
};

// Crear directorios al iniciar
createRequiredDirectories();

// Configuración
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Aumentar el límite de tamaño del cuerpo de la petición
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Sesiones (login)
// Relacionado con:
// - routes/auth.js (POST /login, POST /logout)
// - middleware/auth.js (req.session.user)
// Nota: para uso local/offline. Si requieres persistir sesiones entre reinicios,
// se puede cambiar a un store en BD (no incluido aquí para mantener simple).
app.use(session({
    name: 'sr.sid',
    secret: process.env.SESSION_SECRET || 'cambia_este_secret_en_.env',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 12 // 12 horas
    }
}));

// Hacer disponible el usuario en EJS como "user"
app.use(attachUserToLocals);

// Configuración de archivos estáticos
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Vendor assets (para funcionar OFFLINE incluso empaquetado con pkg)
// Nota: estos paths deben existir en node_modules y estar incluidos en package.json -> pkg.assets
app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules', 'bootstrap', 'dist')));
app.use('/vendor/jquery', express.static(path.join(__dirname, 'node_modules', 'jquery', 'dist')));
app.use('/vendor/sweetalert2', express.static(path.join(__dirname, 'node_modules', 'sweetalert2', 'dist')));
app.use('/vendor/select2', express.static(path.join(__dirname, 'node_modules', 'select2', 'dist')));
app.use('/vendor/select2-bootstrap-5-theme', express.static(path.join(__dirname, 'node_modules', 'select2-bootstrap-5-theme', 'dist')));
// bootstrap-icons usa fuentes (woff/woff2) -> servir carpeta font completa
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules', 'bootstrap-icons', 'font')));

// Headers de seguridad y CORS
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Responder preflight sin caer en 404
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Rutas
const productosRoutes = require('./routes/productos');
const clientesRoutes = require('./routes/clientes');
const facturasRoutes = require('./routes/facturas');
const mesasRoutes = require('./routes/mesas');
const cocinaRoutes = require('./routes/cocina');
const configuracionRoutes = require('./routes/configuracion');
const ventasRoutes = require('./routes/ventas');
const authRoutes = require('./routes/auth');
const usuariosRoutes = require('./routes/usuarios');
const stockRoutes = require('./routes/stock');

// Auth routes (públicas): /login /logout /setup
app.use(authRoutes);

// Ruta principal (requiere login)
app.get('/', requireAuth, (req, res) => {
    const rol = String(req.session?.user?.rol || '').toLowerCase();
    if (rol === 'cocinero') return res.redirect('/cocina');
    if (rol === 'mesero') return res.redirect('/mesas');
    // admin
    res.render('index');
});

// Usar las rutas
// Panel de usuarios (solo admin)
app.use('/usuarios', requireRole('administrador'), usuariosRoutes);
app.use('/api/usuarios', requireRole('administrador'), usuariosRoutes);

// Productos
app.use('/productos', requireRole('administrador'), productosRoutes); // panel admin
app.use('/api/productos', requireRole(['mesero', 'administrador']), productosRoutes); // búsqueda/armado pedido

// Clientes
app.use('/clientes', requireRole('administrador'), clientesRoutes);
app.use('/api/clientes', requireRole(['mesero', 'administrador']), clientesRoutes);

// Facturas (impresión/creación). Mesero necesita imprimir desde Mesas.
app.use('/facturas', requireRole('administrador'), facturasRoutes);
app.use('/api/facturas', requireRole(['mesero', 'administrador']), facturasRoutes);

// Mesas (mesero/admin)
app.use('/mesas', requireRole(['mesero', 'administrador']), mesasRoutes);
app.use('/api/mesas', requireRole(['mesero', 'administrador']), mesasRoutes);

// Cocina
// - Cocinero/Admin: puede preparar/marcar listo
// - Mesero: solo visualiza y marca "Entregado" en la pestaña de listos (la acción se hace vía /api/mesas/items/:id/estado con validación)
// Relacionado con: routes/cocina.js (middlewares por ruta) y routes/mesas.js (restricción servido)
app.use('/cocina', requireRole(['cocinero', 'mesero', 'administrador']), cocinaRoutes);
app.use('/api/cocina', requireRole(['cocinero', 'mesero', 'administrador']), cocinaRoutes);

// Configuración y ventas (admin)
app.use('/configuracion', requireRole('administrador'), configuracionRoutes);
app.use('/ventas', requireRole('administrador'), ventasRoutes);
app.use('/stock', requireRole('administrador'), stockRoutes);

// Ruta para la página de productos
app.get('/productos', async (req, res) => {
    try {
        const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre');
        res.render('productos', { productos: productos || [] });
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).render('error', { 
            error: {
                message: 'Error al obtener productos',
                stack: process.env.NODE_ENV === 'development' ? error.stack : ''
            }
        });
    }
});

// Manejo de errores 404
app.use((req, res, next) => {
    console.log('404 - Ruta no encontrada:', req.url);
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        res.status(404).json({ error: 'Ruta no encontrada' });
    } else {
        res.status(404).render('404');
    }
});

// Manejo de errores generales
app.use((err, req, res, next) => {
    console.error('Error en la aplicación:', err);
    
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        res.status(500).json({ 
            error: 'Error interno del servidor',
            message: process.env.NODE_ENV === 'development' ? err.message : 'Error interno'
        });
    } else {
        res.status(500).render('error', {
            error: {
                message: 'Error interno del servidor',
                stack: process.env.NODE_ENV === 'development' ? err.stack : ''
            }
        });
    }
});

// Puerto preferido:
// - APP_PORT: variable específica de este sistema (recomendada para evitar conflictos con otros proyectos)
// - PORT: compatibilidad con entornos existentes
// - 3002: fallback por defecto
const PORT = Number(process.env.APP_PORT || process.env.PORT || 3002);

// Verificar la conexión a la base de datos antes de iniciar el servidor
async function startServer() {
    try {
        console.log('Intentando conectar a la base de datos...');
        const connection = await db.getConnection();
        connection.release();
        if (typeof db.ensureSchema === 'function') await db.ensureSchema();
        console.log('Conexión exitosa a la base de datos');

        // Iniciar el servidor solo si la conexión a la base de datos es exitosa.
        // Si el puerto está ocupado, probamos automáticamente el siguiente disponible.
        // Relacionado con: escenarios donde hay otros Node corriendo en la misma máquina.
        const host = '0.0.0.0';
        const maxIntentosPuerto = 10;

        function listenConFallback(puertoInicial, intentosRestantes) {
            return new Promise((resolve, reject) => {
                const puerto = Number(puertoInicial);
                const server = app.listen(puerto, host, () => {
                    console.log(`Servidor corriendo en http://localhost:${puerto} (LAN habilitada)`);
                    console.log('Rutas disponibles:');
                    console.log('- GET  /', '(Página principal)');
                    console.log('- POST /api/facturas', '(Generar factura)');
                    console.log('- GET  /api/facturas/:id/imprimir', '(Imprimir factura)');
                    resolve(server);
                });

                server.on('error', (error) => {
                    if (error && error.code === 'EADDRINUSE') {
                        if (intentosRestantes > 0) {
                            const siguiente = puerto + 1;
                            console.warn(`Puerto ${puerto} en uso. Probando ${siguiente}...`);
                            try { server.close(); } catch (_) {}
                            return resolve(listenConFallback(siguiente, intentosRestantes - 1));
                        }
                        return reject(new Error(`No hay puertos disponibles desde ${puerto} hasta ${puerto + maxIntentosPuerto}`));
                    }
                    reject(error);
                });
            });
        }

        await listenConFallback(PORT, maxIntentosPuerto);

    } catch (err) {
        console.error('Error al conectar a la base de datos:', err);
        process.exit(1);
    }
}

// Manejar señales de terminación
process.on('SIGTERM', () => {
    console.log('Recibida señal SIGTERM. Cerrando servidor...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Recibida señal SIGINT. Cerrando servidor...');
    process.exit(0);
});

startServer(); 