const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');

// Configuración de multer para memoria
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: function (req, file, cb) {
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
            return cb(new Error('Solo se permiten imágenes'));
        }
        cb(null, true);
    }
});

// Función para verificar y crear configuración inicial
async function verificarConfiguracion() {
    try {
        const [config] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
        
        if (!config || config.length === 0) {
            // Crear configuración inicial
            await db.query(`
                INSERT INTO configuracion_impresion 
                (nombre_negocio, direccion, telefono, pie_pagina) 
                VALUES 
                ('Mi Negocio', 'Dirección del Negocio', 'Teléfono', '¡Gracias por su compra!')
            `);
            console.log('Configuración inicial creada');
        }
    } catch (error) {
        console.error('Error al verificar configuración:', error);
    }
}

// Verificar configuración al iniciar
verificarConfiguracion();

// Obtener configuración
router.get('/', async (req, res) => {
    try {
        const [config] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
        
        if (!config || config.length === 0) {
            // Si no hay configuración, renderizar la vista con valores por defecto
            return res.render('configuracion', { 
                config: {
                    nombre_negocio: '',
                    direccion: '',
                    telefono: '',
                    nit: '',
                    pie_pagina: '',
                    ancho_papel: 80,
                    font_size: 1,
                    // Previsualizadores (vacíos en configuración por defecto)
                    logo_src: null,
                    qr_src: null
                }
            });
        }

        // Construir previsualización (data URL) si ya hay logo/QR guardados
        // Relacionado con: views/configuracion.ejs (muestra "Logo actual" y "QR actual")
        const configSinImagenes = { ...config[0] };
        if (configSinImagenes.logo_data) {
            try {
                const logoBuffer = Buffer.from(configSinImagenes.logo_data);
                const tipo = configSinImagenes.logo_tipo || 'png';
                configSinImagenes.logo_src = `data:image/${tipo};base64,${logoBuffer.toString('base64')}`;
            } catch (_) {
                configSinImagenes.logo_src = null;
            }
        } else {
            configSinImagenes.logo_src = null;
        }
        if (configSinImagenes.qr_data) {
            try {
                const qrBuffer = Buffer.from(configSinImagenes.qr_data);
                const tipo = configSinImagenes.qr_tipo || 'png';
                configSinImagenes.qr_src = `data:image/${tipo};base64,${qrBuffer.toString('base64')}`;
            } catch (_) {
                configSinImagenes.qr_src = null;
            }
        } else {
            configSinImagenes.qr_src = null;
        }

        // No enviar los datos binarios de las imágenes a la vista (solo logo_src/qr_src)
        delete configSinImagenes.logo_data;
        delete configSinImagenes.qr_data;

        res.render('configuracion', { config: configSinImagenes });
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ error: 'Error al obtener configuración' });
    }
});

// Guardar configuración
router.post('/', upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'qr', maxCount: 1 }
]), async (req, res) => {
    try {
        const {
            nombre_negocio,
            direccion,
            telefono,
            nit,
            pie_pagina,
            ancho_papel,
            font_size
        } = req.body;

        const [results] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');

        let values = [
            nombre_negocio,
            direccion || null,
            telefono || null,
            nit || null,
            pie_pagina || null,
            ancho_papel || 80,
            font_size || 1
        ];

        // Agregar datos de imágenes si se subieron nuevas
        if (req.files?.logo) {
            values.push(req.files.logo[0].buffer);
            values.push(req.files.logo[0].mimetype.split('/')[1]);
        }
        if (req.files?.qr) {
            values.push(req.files.qr[0].buffer);
            values.push(req.files.qr[0].mimetype.split('/')[1]);
        }

        if (!results || results.length === 0) {
            // Insertar nueva configuración
            let sql = `
                INSERT INTO configuracion_impresion 
                (nombre_negocio, direccion, telefono, nit, pie_pagina, 
                 ancho_papel, font_size
            `;
            if (req.files?.logo) sql += ', logo_data, logo_tipo';
            if (req.files?.qr) sql += ', qr_data, qr_tipo';
            sql += ') VALUES (' + values.map(() => '?').join(',') + ')';
            
            await db.query(sql, values);
        } else {
            // Actualizar configuración existente
            let sql = `
                UPDATE configuracion_impresion 
                SET nombre_negocio = ?, direccion = ?, telefono = ?, nit = ?,
                    pie_pagina = ?, ancho_papel = ?, font_size = ?
            `;
            if (req.files?.logo) sql += ', logo_data = ?, logo_tipo = ?';
            if (req.files?.qr) sql += ', qr_data = ?, qr_tipo = ?';
            sql += ' WHERE id = ?';
            
            values.push(results[0].id);
            
            await db.query(sql, values);
        }

        res.redirect('/configuracion');
    } catch (error) {
        console.error('Error en el procesamiento:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Eliminar la ruta de impresoras que no se usa
router.get('/impresoras', (req, res) => {
    res.json([]);
});

module.exports = router; 