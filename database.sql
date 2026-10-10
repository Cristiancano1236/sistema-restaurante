CREATE DATABASE IF NOT EXISTS reconocimiento;
USE reconocimiento;

CREATE TABLE IF NOT EXISTS productos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    precio_kg DECIMAL(10,2) NOT NULL DEFAULT 0,
    precio_unidad DECIMAL(10,2) NOT NULL DEFAULT 0,
    precio_libra DECIMAL(10,2) NOT NULL DEFAULT 0,
    -- Inventario opt-in: los productos existentes siguen sin control hasta activarlo.
    controla_stock TINYINT(1) NOT NULL DEFAULT 0,
    stock_actual DECIMAL(10,2) NOT NULL DEFAULT 0,
    stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 0,
    unidad_stock ENUM('KG','UND','LB') NOT NULL DEFAULT 'UND',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Relación padre -> hijo usando productos existentes (legado/compatibilidad)
-- Ejemplo: Producto padre "CORRIENTE" con hijos que también son productos.
-- Relacionado con:
-- - routes/productos.js (endpoints /api/productos/:padreId/hijos)
-- - public/js/mesas.js (fallback cuando no hay hijos-items)
CREATE TABLE IF NOT EXISTS producto_hijos (
    producto_padre_id INT NOT NULL,
    producto_hijo_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (producto_padre_id, producto_hijo_id),
    FOREIGN KEY (producto_padre_id) REFERENCES productos(id) ON DELETE CASCADE,
    FOREIGN KEY (producto_hijo_id) REFERENCES productos(id) ON DELETE CASCADE
);


-- Hijos como "items" de texto (NO son productos, no tienen precio)
-- Se usa para configurar componentes/opciones internas del producto padre.
-- Ejemplo: Producto padre "CORRIENTE" -> items: "Goulash de cerdo", "Crema"
-- Relacionado con:
-- - routes/productos.js (endpoints /api/productos/:padreId/hijos-items)
-- - views/productos.ejs + public/js/productos.js (panel para administrar items)
-- - public/js/mesas.js (al montar pedido: seleccionar items y guardar en pedido_items.nota)
CREATE TABLE IF NOT EXISTS producto_hijos_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    producto_padre_id INT NOT NULL,
    nombre VARCHAR(120) NOT NULL,
    orden INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_padre_nombre (producto_padre_id, nombre),
    FOREIGN KEY (producto_padre_id) REFERENCES productos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clientes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    nombre VARCHAR(100) NOT NULL,
    direccion TEXT,
    telefono VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS facturas (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cliente_id INT,
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total DECIMAL(10,2) NOT NULL,
    -- forma_pago se mantiene por compatibilidad (reportes/ventas), pero si hay varios pagos se guarda como 'mixto'
    forma_pago ENUM('efectivo', 'transferencia', 'tarjeta', 'qr', 'mixto') NOT NULL DEFAULT 'efectivo',
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

-- Pagos por factura (permite pago mixto: varias filas por la misma factura)
-- Relacionado con:
-- - routes/facturas.js (POST /api/facturas guarda aquí)
-- - routes/mesas.js (POST /api/mesas/pedidos/:id/facturar guarda aquí)
-- - views/factura.ejs (imprime el detalle de pagos)
CREATE TABLE IF NOT EXISTS factura_pagos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    factura_id INT NOT NULL,
    metodo ENUM('efectivo', 'transferencia', 'tarjeta', 'qr') NOT NULL,
    monto DECIMAL(10,2) NOT NULL,
    referencia VARCHAR(100) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS detalle_factura (
    id INT PRIMARY KEY AUTO_INCREMENT,
    factura_id INT,
    producto_id INT,
    cantidad DECIMAL(10,2) NOT NULL,
    precio_unitario DECIMAL(10,2) NOT NULL,
    unidad_medida ENUM('KG', 'UND', 'LB') DEFAULT 'KG',
    subtotal DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (factura_id) REFERENCES facturas(id),
    FOREIGN KEY (producto_id) REFERENCES productos(id)
);

CREATE TABLE IF NOT EXISTS configuracion_impresion (
    id INT PRIMARY KEY AUTO_INCREMENT,
    nombre_negocio VARCHAR(100) NOT NULL,
    direccion TEXT,
    telefono VARCHAR(20),
    nit VARCHAR(50),
    pie_pagina TEXT,
    ancho_papel INT DEFAULT 80,
    font_size INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    logo_data LONGBLOB,
    logo_tipo VARCHAR(50),
    qr_data LONGBLOB,
    qr_tipo VARCHAR(50),
    -- Modo operativo: cocina sin dispositivo.
    -- Si está activo, al enviar desde Mesas se imprime comanda y el item pasa directo a "listo".
    cocina_auto_listo_comanda TINYINT(1) NOT NULL DEFAULT 0,
    -- Si está activo, la comanda se imprime en el servidor (PC), no en el navegador del celular.
    cocina_imprime_servidor TINYINT(1) NOT NULL DEFAULT 0,
    -- Preferencias de impresión (referenciales en entorno web).
    impresora_comandas VARCHAR(150) NULL,
    impresora_facturas VARCHAR(150) NULL,
    factura_imprime_servidor TINYINT(1) NOT NULL DEFAULT 0,
    factura_copias INT NOT NULL DEFAULT 1,
    factura_auto_print TINYINT(1) NOT NULL DEFAULT 0
); 

-- ===========================
-- USUARIOS / LOGIN / ROLES
-- Roles soportados: administrador, mesero, cocinero
-- Relacionado con:
-- - routes/auth.js (login/logout/setup)
-- - routes/usuarios.js (panel CRUD usuarios)
-- - middleware/auth.js (requireAuth/requireRole)
-- - views/login.ejs, views/usuarios.ejs, views/partials/navbar.ejs
-- ===========================
CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    usuario VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(100) NULL,
    password_hash VARCHAR(255) NOT NULL,
    rol ENUM('administrador','mesero','cocinero') NOT NULL DEFAULT 'mesero',
    activo TINYINT(1) NOT NULL DEFAULT 1,
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Seed: crear/asegurar usuario administrador por defecto
-- Usuario: admin
-- Contraseña: admin123
-- IMPORTANTE: cambia esta contraseña en Producción.
-- Relacionado con: routes/auth.js (login) y routes/usuarios.js (panel usuarios)
INSERT INTO usuarios (usuario, nombre, password_hash, rol, activo)
VALUES ('admin', 'Administrador', '$2b$10$io4GOTM300XQHIsHtB0b4evsgKCQ2MMqCYXPyUnvXGUnAukq/xMNW', 'administrador', 1)
ON DUPLICATE KEY UPDATE
  nombre = VALUES(nombre),
  password_hash = VALUES(password_hash),
  rol = 'administrador',
  activo = 1;

-- Tablas para restaurante: mesas, pedidos y items de pedido
CREATE TABLE IF NOT EXISTS mesas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    numero VARCHAR(20) NOT NULL UNIQUE,
    descripcion VARCHAR(100),
    estado ENUM('libre', 'ocupada', 'reservada', 'bloqueada') DEFAULT 'libre',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedidos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mesa_id INT NOT NULL,
    cliente_id INT,
    -- Nombre del usuario (mesero/admin) que abrió la comanda.
    -- Se guarda en snapshot para trazabilidad histórica aunque el usuario cambie luego.
    mesero_nombre VARCHAR(100) NULL,
    -- Estado del pedido (flujo general). "rechazado" se usa cuando el pedido se cancela/rechaza.
    -- Relacionado con:
    -- - routes/mesas.js (liberar mesa -> marca pedido rechazado)
    -- - routes/cocina.js + views/cocina.ejs + public/js/cocina.js (pestaña Rechazados)
    estado ENUM('abierto', 'en_cocina', 'preparando', 'listo', 'servido', 'cerrado', 'cancelado', 'rechazado') DEFAULT 'abierto',
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (mesa_id) REFERENCES mesas(id),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

CREATE TABLE IF NOT EXISTS pedido_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pedido_id INT NOT NULL,
    producto_id INT NOT NULL,
    cantidad DECIMAL(10,2) NOT NULL,
    unidad_medida ENUM('KG', 'UND', 'LB') DEFAULT 'UND',
    precio_unitario DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    -- Estado del item (lo que cocina procesa). "rechazado" se usa para visualizar cancelaciones.
    -- Relacionado con:
    -- - routes/mesas.js (al rechazar/cancelar pedido, se marca el item como rechazado)
    -- - routes/cocina.js + public/js/cocina.js (GET /api/cocina/rechazados)
    estado ENUM('pendiente', 'enviado', 'preparando', 'listo', 'servido', 'cancelado', 'rechazado') DEFAULT 'pendiente',
    nota TEXT NULL,
    enviado_at TIMESTAMP NULL,
    preparado_at TIMESTAMP NULL,
    listo_at TIMESTAMP NULL,
    servido_at TIMESTAMP NULL,
    -- Marca cuándo la línea ya fue incluida en una comanda impresa.
    -- Evita duplicar impresión cuando la mesa agrega más productos después.
    comanda_impresa_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
    FOREIGN KEY (producto_id) REFERENCES productos(id)
);

-- ===========================
-- MIGRACIÓN (si ya tienes BD creada)
-- Ejecuta estos ALTER/CREATE en tu base ya existente para habilitar pago mixto.
-- ===========================

-- 1) Agregar métodos extra al ENUM de facturas.forma_pago (incluye 'tarjeta', 'qr' y 'mixto')
ALTER TABLE facturas
    MODIFY forma_pago ENUM('efectivo','transferencia','tarjeta','qr','mixto') NOT NULL DEFAULT 'efectivo';

-- 1.1) Agregar 'qr' al ENUM de factura_pagos.metodo
ALTER TABLE factura_pagos
    MODIFY metodo ENUM('efectivo','transferencia','tarjeta','qr') NOT NULL;

-- 2) Crear tabla de pagos por factura (si aún no existe)
CREATE TABLE IF NOT EXISTS factura_pagos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    factura_id INT NOT NULL,
    metodo ENUM('efectivo', 'transferencia', 'tarjeta', 'qr') NOT NULL,
    monto DECIMAL(10,2) NOT NULL,
    referencia VARCHAR(100) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE
);

-- 2.1) Modo cocina sin dispositivo (si la columna aún no existe)
ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS cocina_auto_listo_comanda TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS cocina_imprime_servidor TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS impresora_comandas VARCHAR(150) NULL;

ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS impresora_facturas VARCHAR(150) NULL;

ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS factura_imprime_servidor TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS factura_copias INT NOT NULL DEFAULT 1;

ALTER TABLE configuracion_impresion
    ADD COLUMN IF NOT EXISTS factura_auto_print TINYINT(1) NOT NULL DEFAULT 0;

-- 3) Agregar estado "rechazado" a pedidos y pedido_items (si ya existían)
-- Nota: Esto permite marcar pedidos cancelados como rechazados y visualizarlos en Cocina.
-- Relacionado con:
-- - routes/mesas.js (liberar mesa -> rechazar pedido)
-- - routes/cocina.js / public/js/cocina.js (pestaña Rechazados)

-- 4) Agregar columna mesero_nombre a pedidos
ALTER TABLE pedidos
    ADD COLUMN IF NOT EXISTS mesero_nombre VARCHAR(100) NULL AFTER cliente_id;

ALTER TABLE pedidos
    MODIFY estado ENUM('abierto', 'en_cocina', 'preparando', 'listo', 'servido', 'cerrado', 'cancelado', 'rechazado') DEFAULT 'abierto';

ALTER TABLE pedido_items
    MODIFY estado ENUM('pendiente', 'enviado', 'preparando', 'listo', 'servido', 'cancelado', 'rechazado') DEFAULT 'pendiente';

ALTER TABLE pedido_items
    ADD COLUMN IF NOT EXISTS comanda_impresa_at TIMESTAMP NULL AFTER servido_at;

-- 6) Crear relación padre-hijo de productos (compatibilidad con rutas legacy)
CREATE TABLE IF NOT EXISTS producto_hijos (
    producto_padre_id INT NOT NULL,
    producto_hijo_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (producto_padre_id, producto_hijo_id),
    FOREIGN KEY (producto_padre_id) REFERENCES productos(id) ON DELETE CASCADE,
    FOREIGN KEY (producto_hijo_id) REFERENCES productos(id) ON DELETE CASCADE
);

-- 7) Control de stock por producto (kardex)
-- Se descuenta al enviar a cocina y se devuelve al cancelar o rechazar.
-- Relacionado con: db.js (ensureSchema), services/stock.js, routes/stock.js
ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS controla_stock TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS stock_actual DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS unidad_stock ENUM('KG','UND','LB') NOT NULL DEFAULT 'UND';

CREATE TABLE IF NOT EXISTS stock_movimientos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    producto_id INT NOT NULL,
    tipo ENUM('entrada','salida_cocina','devolucion','ajuste') NOT NULL,
    cantidad DECIMAL(10,2) NOT NULL,
    stock_anterior DECIMAL(10,2) NOT NULL,
    stock_nuevo DECIMAL(10,2) NOT NULL,
    pedido_item_id INT NULL,
    motivo VARCHAR(200) NULL,
    usuario_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_stock_item_tipo (pedido_item_id, tipo),
    KEY idx_stock_producto (producto_id, id),
    FOREIGN KEY (producto_id) REFERENCES productos(id),
    FOREIGN KEY (pedido_item_id) REFERENCES pedido_items(id) ON DELETE SET NULL,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
);