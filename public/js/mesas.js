// JS de Mesas: UI para abrir/gestionar pedidos por mesa y enviar a cocina
// Relacionado con: views/mesas.ejs, routes/mesas.js, routes/productos.js, routes/facturas.js

$(function() {
  const canvas = new bootstrap.Offcanvas('#canvasPedido');
  let pedidoActual = null; // { id, mesa_id }
  let items = []; // items del pedido en UI
  let autoListoComanda = false; // configuración global de flujo de cocina
  let imprimeServidor = false; // impresión de comanda en PC/servidor
  // Rol actual (inyectado desde views/mesas.ejs)
  // Relacionado con: views/mesas.ejs (window.__USER_ROLE__) y server.js (protección de rutas)
  const userRole = String(window.__USER_ROLE__ || '').toLowerCase(); // administrador | mesero

  // ===== Pago mixto (varios medios) =====
  // Relacionado con:
  // - routes/mesas.js (POST /api/mesas/pedidos/:pedidoId/facturar recibe pagos[])
  // - database.sql -> tabla factura_pagos
  function parseMoneyInput(value) {
    // Acepta "10.000", "10000", "10,000.50", etc. Normaliza a Number.
    const v = String(value ?? '').trim();
    if (!v) return 0;
    // Si tiene coma y punto, asumimos coma miles y punto decimal (ej: 10,000.50)
    // Si solo tiene coma, asumimos coma decimal (ej: 10,5)
    let normalized = v.replace(/\s/g, '');
    const hasComma = normalized.includes(',');
    const hasDot = normalized.includes('.');
    if (hasComma && hasDot) {
      normalized = normalized.replace(/,/g, '');
    } else if (hasComma && !hasDot) {
      normalized = normalized.replace(/,/g, '.');
    }
    // Quitar cualquier caracter no numérico excepto '.' y '-'
    normalized = normalized.replace(/[^\d.-]/g, '');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  function formatMoney(n) {
    return `$${Number(n || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function almostEqualMoney(a, b) {
    return Math.abs(Number(a) - Number(b)) < 0.01;
  }

  async function pedirPagosMixtos(total) {
    // Modal SweetAlert con UI dinámica (agregar/eliminar filas)
    // Importante: usamos didOpen para enlazar eventos.
    const result = await Swal.fire({
      title: 'Forma de pago',
      html: `
        <div class="text-start">
          <div class="small text-muted mb-2">Total a pagar: <strong id="pmTotal">${formatMoney(total)}</strong></div>

          <div id="pmRows" class="vstack gap-2"></div>

          <div class="d-flex gap-2 mt-2">
            <button type="button" class="btn btn-outline-primary btn-sm" id="pmAddRow">
              <i class="bi bi-plus-lg"></i> Agregar medio
            </button>
            <div class="ms-auto small text-muted align-self-center">
              Sumatoria: <strong id="pmSum">${formatMoney(0)}</strong>
            </div>
          </div>

          <!-- Indicador de diferencia para guiar al usuario -->
          <!-- Relacionado con: UX solicitada (mostrar Falta/Sobra) -->
          <div class="mt-2" id="pmDiffWrap">
            <span class="badge text-bg-secondary" id="pmDiff">Falta: ${formatMoney(total)}</span>
          </div>

          <div class="alert alert-warning py-2 px-3 mt-2 mb-0 small" id="pmWarn" style="display:none"></div>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Confirmar pago',
      cancelButtonText: 'Cancelar',
      focusConfirm: false,
      didOpen: () => {
        const rows = document.getElementById('pmRows');
        const btnAdd = document.getElementById('pmAddRow');
        const sumEl = document.getElementById('pmSum');
        const diffEl = document.getElementById('pmDiff');
        const warnEl = document.getElementById('pmWarn');

        const allowClipboard = (el) => {
          if (!el) return;
          // Solo detenemos propagación de eventos que suelen activar atajos globales / offcanvas,
          // pero NO bloqueamos escritura normal.
          ['paste','copy','cut','contextmenu'].forEach(evt => {
            el.addEventListener(evt, (e) => e.stopPropagation());
          });
        };

        const rowTemplate = (metodo = 'efectivo', monto = '', referencia = '') => `
          <div class="border rounded p-2 pm-row">
            <div class="row g-2 align-items-end">
              <div class="col-5">
                <label class="form-label small mb-1">Método</label>
                <select class="form-select form-select-sm pm-metodo">
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="tarjeta">Tarjeta</option>
                </select>
              </div>
              <div class="col-4">
                <label class="form-label small mb-1">Monto</label>
                <input type="text" class="form-control form-control-sm pm-monto" placeholder="0.00" value="${String(monto)}">
              </div>
              <div class="col-3 text-end">
                <button type="button" class="btn btn-outline-danger btn-sm pm-del" title="Eliminar">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
              <div class="col-12">
                <label class="form-label small mb-1">Referencia (opcional)</label>
                <input type="text" class="form-control form-control-sm pm-ref" placeholder="Ej: #transacción / últimos 4 dígitos" value="${String(referencia)}">
              </div>
            </div>
          </div>
        `;

        // Autocompletar el restante en una fila "no tocada" por el usuario
        const recalc = (sourceInput = null) => {
          const montoInputs = Array.from(rows.querySelectorAll('.pm-monto'));
          const montos = montoInputs.map(i => parseMoneyInput(i.value));
          const sum = montos.reduce((a, b) => a + b, 0);

          // Indicador Falta/Sobra
          const diff = Number(total) - Number(sum);
          if (diffEl) {
            if (almostEqualMoney(diff, 0)) {
              diffEl.className = 'badge text-bg-success';
              diffEl.textContent = 'Listo: total completo';
            } else if (diff > 0) {
              diffEl.className = 'badge text-bg-warning';
              diffEl.textContent = `Falta: ${formatMoney(diff)}`;
            } else {
              diffEl.className = 'badge text-bg-danger';
              diffEl.textContent = `Sobra: ${formatMoney(Math.abs(diff))}`;
            }
          }

          sumEl.textContent = formatMoney(sum);
          warnEl.style.display = 'none';

          // Si falta dinero, intentamos autocompletar el restante en la última fila no tocada
          // (diferente a la que el usuario está editando).
          const remaining = Number(total) - Number(sum);
          if (remaining > 0.009) {
            const candidate = montoInputs
              .filter(inp => inp !== sourceInput)
              .reverse()
              .find(inp => inp && inp.dataset && inp.dataset.touched !== 'true');
            if (candidate) {
              candidate.value = Number(remaining.toFixed(2)).toString();
              // NO marcar touched aquí: sigue siendo autocompletado
              // Recalcular sin bucle infinito
              const montos2 = montoInputs.map(i => parseMoneyInput(i.value));
              const sum2 = montos2.reduce((a, b) => a + b, 0);
              sumEl.textContent = formatMoney(sum2);
              const diff2 = Number(total) - Number(sum2);
              if (diffEl) {
                if (almostEqualMoney(diff2, 0)) {
                  diffEl.className = 'badge text-bg-success';
                  diffEl.textContent = 'Listo: total completo';
                } else if (diff2 > 0) {
                  diffEl.className = 'badge text-bg-warning';
                  diffEl.textContent = `Falta: ${formatMoney(diff2)}`;
                } else {
                  diffEl.className = 'badge text-bg-danger';
                  diffEl.textContent = `Sobra: ${formatMoney(Math.abs(diff2))}`;
                }
              }
            }
          }
        };

        const addRow = (metodo = 'efectivo', monto = '', referencia = '') => {
          const wrap = document.createElement('div');
          wrap.innerHTML = rowTemplate(metodo, monto, referencia);
          const row = wrap.firstElementChild;
          rows.appendChild(row);

          const sel = row.querySelector('.pm-metodo');
          const montoEl = row.querySelector('.pm-monto');
          const refEl = row.querySelector('.pm-ref');
          const del = row.querySelector('.pm-del');

          if (sel) sel.value = metodo;

          allowClipboard(montoEl);
          allowClipboard(refEl);

          if (montoEl) {
            montoEl.dataset.touched = 'false';
            montoEl.addEventListener('input', () => {
              montoEl.dataset.touched = 'true';
              recalc(montoEl);
            });
            // Enfoque: seleccionar todo para editar rápido
            montoEl.addEventListener('focus', () => {
              try { montoEl.select(); } catch (_) {}
            });
          }
          if (sel) sel.addEventListener('change', () => recalc(montoEl));
          if (del) del.addEventListener('click', () => { row.remove(); recalc(); });

          // UX: enfocar monto al agregar
          if (montoEl) setTimeout(() => montoEl.focus(), 0);

          recalc();
        };

        btnAdd.addEventListener('click', () => addRow('efectivo', '', ''));

        // Fila inicial: por defecto todo en efectivo
        addRow('efectivo', String(Number(total).toFixed(2)), '');

        // Exponer helpers para preConfirm
        window.__pm_getRows = () => rows;
        window.__pm_setWarn = (msg) => {
          warnEl.textContent = msg;
          warnEl.style.display = 'block';
        };
      },
      preConfirm: () => {
        const rows = window.__pm_getRows ? window.__pm_getRows() : null;
        if (!rows) return false;
        let pagos = Array.from(rows.querySelectorAll('.pm-row')).map(r => {
          const metodo = (r.querySelector('.pm-metodo')?.value || '').trim();
          const monto = parseMoneyInput(r.querySelector('.pm-monto')?.value || 0);
          const referencia = (r.querySelector('.pm-ref')?.value || '').trim();
          return { metodo, monto, referencia };
        }).filter(p => p.metodo && p.monto > 0);

        if (pagos.length === 0) {
          window.__pm_setWarn && window.__pm_setWarn('Agrega al menos un medio de pago con monto.');
          return false;
        }

        const sum = pagos.reduce((a, p) => a + Number(p.monto || 0), 0);

        // Bloquear solo si la suma es MENOR al total (falta dinero)
        if (sum < Number(total) - 0.01) {
          window.__pm_setWarn && window.__pm_setWarn(`La sumatoria (${formatMoney(sum)}) es menor al total (${formatMoney(total)}). Falta: ${formatMoney(Number(total) - sum)}`);
          return false;
        }

        // Si hay vuelto (cliente paga con billete mayor), reducir el último pago
        // para guardar solo el monto cobrado, no el excedente devuelto como cambio
        if (sum > Number(total) + 0.01) {
          const exceso = Number((sum - Number(total)).toFixed(2));
          for (let i = pagos.length - 1; i >= 0; i--) {
            if (pagos[i].monto >= exceso) {
              pagos[i] = { ...pagos[i], monto: Number((pagos[i].monto - exceso).toFixed(2)) };
              break;
            }
          }
          pagos = pagos.filter(p => p.monto > 0);
        }

        // Limpieza final
        return pagos.map(p => ({
          metodo: p.metodo,
          monto: Number(p.monto.toFixed(2)),
          referencia: p.referencia || ''
        }));
      },
      willClose: () => {
        // Limpieza de variables globales del modal (evitar fugas)
        try { delete window.__pm_getRows; delete window.__pm_setWarn; } catch (_) {}
      }
    });

    if (!result.isConfirmed) return null;
    return result.value;
  }

  // Tooltips Bootstrap
  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
    try { new bootstrap.Tooltip(el); } catch (_) { /* noop */ }
  });

  // Helpers UI
  function formatear(valor){return `$${Number(valor||0).toLocaleString('es-CO')}`}
  function isItemAnulable(estado){
    const e = String(estado || '').toLowerCase();
    return ['pendiente','enviado','preparando','listo'].includes(e);
  }
  function isItemExcluidoDeTotal(estado){
    const e = String(estado || '').toLowerCase();
    return ['cancelado','rechazado'].includes(e);
  }
  function renderItems(){
    const tbody = $('#tbodyItems');
    tbody.empty();
    let total = 0;
    items.forEach((it, idx) => {
      const cantidad = Number(it.cantidad || 0);
      const precio = Number((it.precio_unitario != null ? it.precio_unitario : it.precio) || 0);
      const subtotal = Number(it.subtotal != null ? it.subtotal : (cantidad * precio));
      const estadoItem = String(it.estado || '').toLowerCase();
      if (!isItemExcluidoDeTotal(estadoItem)) total += subtotal;
      // Mostrar nota debajo del producto (si existe), útil para "Padre - Hijos / Obs."
      // Relacionado con: public/js/mesas.js (selección de hijos) y Cocina (muestra it.nota)
      const nombre = escapeHtml(it.producto_nombre || it.nombre || it.producto_id);
      const nota = String(it.nota || '').trim();
      const notaHtml = nota ? `<div class="small text-muted mt-1">${escapeHtml(nota)}</div>` : '';
      const canEdit = estadoItem === 'pendiente';
      const canCancelar = isItemAnulable(estadoItem);
      tbody.append(`
        <tr>
          <td>
            <div>${nombre}</div>
            ${notaHtml}
            <div class="small mt-1">
              <span class="badge text-bg-${canEdit ? 'secondary' : 'light'}">${escapeHtml(estadoItem || 'sin estado')}</span>
            </div>
          </td>
          <td class="text-end">${cantidad}</td>
          <td class="text-end">${formatear(precio)}</td>
          <td class="text-end">${formatear(subtotal)}</td>
          <td class="text-end">
            <div class="btn-group btn-group-sm" role="group" aria-label="acciones item">
              ${canEdit ? `<button class="btn btn-outline-primary" data-action="editar-item" data-idx="${idx}" title="Editar item"><i class="bi bi-pencil-square"></i></button>` : ''}
              ${canEdit ? `<button class="btn btn-outline-danger" data-action="eliminar-item" data-idx="${idx}" title="Eliminar item"><i class="bi bi-trash"></i></button>` : ''}
              ${canCancelar ? `<button class="btn btn-outline-warning" data-action="cancelar-item" data-idx="${idx}" title="Cancelar item"><i class="bi bi-x-octagon"></i></button>` : ''}
            </div>
          </td>
        </tr>
      `);
    });
    $('#totalPedido').text(formatear(total));
  }

  // Cargar pedido por mesa
  async function abrirPedido(mesaId, mesaNumero){
    try{
      const resp = await fetch('/api/mesas/abrir', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mesa_id: mesaId })});
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error||'Error al abrir pedido');
      pedidoActual = data.pedido;
      autoListoComanda = !!data.auto_listo_comanda;
      imprimeServidor = !!data.imprime_servidor;
      $('#pedidoMesa').text(mesaNumero);
      await cargarPedido(pedidoActual.id);
      canvas.show();
    }catch(err){
      Swal.fire({icon:'error', title: err.message});
    }
  }

  async function cargarPedido(pedidoId){
    const resp = await fetch(`/api/mesas/pedidos/${pedidoId}`);
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error||'Error al cargar pedido');
    items = data.items || [];
    renderItems();
  }

  // Buscar productos
  let to;
  $('#buscarProductoMesa').on('input', function(){
    clearTimeout(to);
    const q = this.value.trim();
    if(q.length < 2){ $('#resultadosProductoMesa').empty(); return; }
    to = setTimeout(async () => {
      const resp = await fetch(`/api/productos/buscar?q=${encodeURIComponent(q)}`);
      const productos = await resp.json();
      const list = $('#resultadosProductoMesa');
      list.empty();
      productos.forEach(p => {
        const item = $(`
          <a href="#" class="list-group-item list-group-item-action">
            <div><strong>${p.codigo}</strong> - ${p.nombre}</div>
            <div class="small text-muted">KG: $${p.precio_kg} | UND: $${p.precio_unidad} | LB: $${p.precio_libra}</div>
          </a>`);
        item.on('click', e => {
          e.preventDefault();
          $('#resultadosProductoMesa').empty();
          $('#buscarProductoMesa').val('');
          seleccionarProducto(p);
        });
        list.append(item);
      });
    }, 250);
  });

  // Selección rápida: UND por defecto + nota para cocina (oculta offcanvas durante todo el flujo)
  async function seleccionarProducto(p){
    await runWithOffcanvasHidden(async () => {
      // Consultar si el producto seleccionado (padre) tiene "hijos" configurados.
      // NUEVO (preferido): hijos como items de texto -> /hijos-items
      // LEGADO (compat): hijos como productos -> /hijos
      // Relacionado con: routes/productos.js y database.sql (producto_hijos_items / producto_hijos)
      let hijosItems = []; // [{id,nombre,...}]
      let hijosProductos = []; // [{id,nombre,codigo}]
      try {
        const r = await fetch(`/api/productos/${encodeURIComponent(p.id)}/hijos-items`);
        if (r.ok) {
          const data = await r.json();
          hijosItems = Array.isArray(data) ? data : [];
        }
      } catch (_) { hijosItems = []; }

      // Fallback legacy: si no hay items, intentamos hijos como productos
      if (!hijosItems || hijosItems.length === 0) {
        try {
          const r2 = await fetch(`/api/productos/${encodeURIComponent(p.id)}/hijos`);
          if (r2.ok) {
            const data2 = await r2.json();
            hijosProductos = Array.isArray(data2) ? data2 : [];
          }
        } catch (_) { hijosProductos = []; }
      }

      let cantidad = 1;
      let notaFinal = '';

      const tieneHijos = (Array.isArray(hijosItems) && hijosItems.length > 0) || (Array.isArray(hijosProductos) && hijosProductos.length > 0);
      if (!tieneHijos) {
        // Flujo anterior (sin hijos): pedir cantidad y nota opcional
        const cantidadRes = await Swal.fire({
          title: `Cantidad para ${p.nombre}`,
          input: 'number',
          inputValue: 1,
          inputAttributes:{ step: '0.1', min: '0.1' },
          showCancelButton: true,
          didOpen: () => {
            const inp = document.querySelector('.swal2-input');
            if (inp) {
              ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
                inp.addEventListener(evt, e => e.stopPropagation());
              });
            }
          }
        });
        if(!cantidadRes.value) return;

        const notaRes = await Swal.fire({
          title: 'Nota para cocina (opcional)',
          input: 'text',
          inputPlaceholder: 'Ej: sin cebolla, sin queso...',
          showCancelButton: true,
          didOpen: () => {
            const inp = document.querySelector('.swal2-input');
            if (inp) {
              ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
                inp.addEventListener(evt, e => e.stopPropagation());
              });
            }
          }
        });

        cantidad = Number(cantidadRes.value);
        notaFinal = (notaRes.value || '').trim();
      } else {
        // Nuevo flujo (con hijos): seleccionar múltiples hijos + observación en una sola pantalla
        // Renderizamos de forma uniforme, pero con origen distinto:
        // - items: "nombre" (texto)
        // - productos: "nombre" (nombre producto hijo)
        const listaHijos = (Array.isArray(hijosItems) && hijosItems.length > 0)
          ? hijosItems.map(it => ({ key: `i_${it.id}`, label: String(it.nombre || '').trim() }))
          : (hijosProductos || []).map(pr => ({ key: `p_${pr.id}`, label: String(pr.nombre || '').trim() }));

        const hijosHtml = listaHijos.map(h => {
          const key = String(h.key);
          const label = escapeHtml(h.label || '');
          const checkboxId = `phH_${key.replace(/[^a-zA-Z0-9_]/g,'_')}`;
          return `
            <div class="form-check">
              <input class="form-check-input ph-hijo" type="checkbox" value="${escapeHtml(key)}" id="${checkboxId}">
              <label class="form-check-label" for="${checkboxId}">${label}</label>
            </div>
          `;
        }).join('');

        const result = await Swal.fire({
          title: `Montar ${escapeHtml(p.nombre)}`,
          html: `
            <div class="text-start">
              <div class="small text-muted mb-2">
                Selecciona los <strong>hijos</strong> (opcional) y escribe la <strong>observación</strong>. No cambia el precio del producto padre.
              </div>

              <label class="form-label small mb-1">Cantidad</label>
              <input id="phCantidad" type="number" class="form-control mb-2" value="1" step="0.1" min="0.1" />

              <label class="form-label small mb-1">Hijos</label>
              <div class="border rounded p-2 mb-2" style="max-height:220px; overflow:auto;">
                ${hijosHtml}
              </div>

              <label class="form-label small mb-1">Observación (opcional)</label>
              <input id="phObs" type="text" class="form-control" placeholder="Ej: Poco arroz" />
            </div>
          `,
          showCancelButton: true,
          confirmButtonText: 'Agregar al pedido',
          cancelButtonText: 'Cancelar',
          focusConfirm: false,
          didOpen: () => {
            // Evitar que eventos del offcanvas interfieran (copiar/pegar/teclas)
            ['phCantidad', 'phObs'].forEach(id => {
              const el = document.getElementById(id);
              if (!el) return;
              ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
                el.addEventListener(evt, e => e.stopPropagation());
              });
            });
            // Enfocar cantidad al abrir
            const qty = document.getElementById('phCantidad');
            if (qty) setTimeout(() => { try { qty.focus(); qty.select(); } catch(_) {} }, 0);
          },
          preConfirm: () => {
            const qty = Number(document.getElementById('phCantidad')?.value || 0);
            if (!Number.isFinite(qty) || qty <= 0) {
              Swal.showValidationMessage('La cantidad debe ser mayor a 0');
              return false;
            }
            const obs = (document.getElementById('phObs')?.value || '').trim();
            const hijosSel = Array.from(document.querySelectorAll('.ph-hijo:checked'))
              .map(ch => String(ch.value || '').trim())
              .filter(Boolean);
            return { qty, obs, hijosSel };
          }
        });

        if (!result.isConfirmed) return;

        cantidad = Number(result.value.qty);
        const obs = String(result.value.obs || '').trim();
        const hijosSel = Array.isArray(result.value.hijosSel) ? result.value.hijosSel : [];

        // Construir nota final: "Hijo1 / Hijo2 / Obs. ..."
        const mapLabel = new Map(listaHijos.map(h => [String(h.key), String(h.label || '').trim()]));
        const nombresSel = hijosSel.map(k => mapLabel.get(String(k)) || '').map(s => String(s || '').trim()).filter(Boolean);

        const parts = [...nombresSel];
        if (obs) parts.push(`Obs. ${obs}`);
        notaFinal = parts.join(' / ');
      }

      const unidad = 'UND';
      const precio = p.precio_unidad;
      const body = { producto_id: p.id, cantidad: Number(cantidad), unidad, precio: Number(precio), nota: notaFinal || '' };
      const resp = await fetch(`/api/mesas/pedidos/${pedidoActual.id}/items`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const data = await resp.json();
      if(!resp.ok) return Swal.fire({icon:'error', title: data.error||'Error al agregar'});
      await cargarPedido(pedidoActual.id);
      // limpiar y enfocar el buscador para el siguiente producto
      $('#buscarProductoMesa').val('').focus();
    });
  }

  // Cargar hijos configurados de un producto (items preferidos, productos como fallback).
  // Relacionado con:
  // - routes/productos.js (/hijos-items y /hijos)
  // - edición rápida de pedidos con hijos
  async function cargarHijosProducto(productoId){
    let hijosItems = [];
    let hijosProductos = [];
    try {
      const r = await fetch(`/api/productos/${encodeURIComponent(productoId)}/hijos-items`);
      if (r.ok) {
        const data = await r.json();
        hijosItems = Array.isArray(data) ? data : [];
      }
    } catch (_) { hijosItems = []; }

    if (!hijosItems || hijosItems.length === 0) {
      try {
        const r2 = await fetch(`/api/productos/${encodeURIComponent(productoId)}/hijos`);
        if (r2.ok) {
          const data2 = await r2.json();
          hijosProductos = Array.isArray(data2) ? data2 : [];
        }
      } catch (_) { hijosProductos = []; }
    }

    if (Array.isArray(hijosItems) && hijosItems.length > 0) {
      return hijosItems.map(it => ({ key: `i_${it.id}`, label: String(it.nombre || '').trim() })).filter(x => x.label);
    }
    return (hijosProductos || []).map(pr => ({ key: `p_${pr.id}`, label: String(pr.nombre || '').trim() })).filter(x => x.label);
  }

  // Intenta descomponer una nota con formato "Hijo1 / Hijo2 / Obs. texto".
  // Si encuentra texto no coincidente con hijos, lo conserva en observación.
  // Relacionado con: selección/edición de hijos en pedido.
  function parseNotaConHijos(nota, listaHijos){
    const notaRaw = String(nota || '').trim();
    const normalize = (s) => String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    const byLabel = new Map((listaHijos || []).map(h => [normalize(h.label), String(h.key)]));

    if (!notaRaw) return { selectedKeys: [], obs: '' };

    const parts = notaRaw.split('/').map(p => String(p || '').trim()).filter(Boolean);
    const selected = [];
    const extras = [];
    let obs = '';

    parts.forEach(p => {
      if (/^obs\./i.test(p)) {
        const txt = p.replace(/^obs\.\s*/i, '').trim();
        if (txt) obs = txt;
        return;
      }
      const key = byLabel.get(normalize(p));
      if (key) selected.push(key);
      else extras.push(p);
    });

    if (extras.length > 0) {
      obs = obs ? `${extras.join(' / ')} / ${obs}` : extras.join(' / ');
    }
    return { selectedKeys: selected, obs };
  }

  // Editar item del pedido (solo estado pendiente)
  // Relacionado con: routes/mesas.js (PUT /api/mesas/items/:itemId)
  $(document).on('click', '[data-action="editar-item"]', async function(e){
    e.preventDefault();
    const idx = Number($(this).data('idx'));
    const item = items[idx];
    if(!item || !item.id) return;
    if(String(item.estado || '').toLowerCase() !== 'pendiente'){
      return Swal.fire({icon:'info', title:'Solo puedes editar items pendientes'});
    }

    const hijos = await cargarHijosProducto(item.producto_id);
    const hasHijos = Array.isArray(hijos) && hijos.length > 0;
    const notaParsed = parseNotaConHijos(item.nota, hijos);
    const selectedSet = new Set(notaParsed.selectedKeys);

    const result = await runWithOffcanvasHidden(async () => {
      return await Swal.fire({
        title: 'Editar producto',
        html: `
          <div class="text-start">
            <label class="form-label small">Cantidad</label>
            <input id="editItemCantidad" type="number" class="form-control mb-2" step="0.1" min="0.1" value="${Number(item.cantidad || 1)}">

            ${hasHijos ? `
              <label class="form-label small mb-1">Hijos</label>
              <div class="border rounded p-2 mb-2" style="max-height:220px; overflow:auto;">
                ${hijos.map(h => {
                  const key = String(h.key);
                  const checkboxId = `edH_${key.replace(/[^a-zA-Z0-9_]/g,'_')}`;
                  const checked = selectedSet.has(key) ? 'checked' : '';
                  return `
                    <div class="form-check">
                      <input class="form-check-input edit-item-hijo" type="checkbox" value="${escapeHtml(key)}" id="${checkboxId}" ${checked}>
                      <label class="form-check-label" for="${checkboxId}">${escapeHtml(h.label)}</label>
                    </div>
                  `;
                }).join('')}
              </div>
              <label class="form-label small">Observación (opcional)</label>
              <input id="editItemObs" type="text" class="form-control" value="${escapeHtml(String(notaParsed.obs || ''))}" placeholder="Ej: Poco arroz">
            ` : `
              <label class="form-label small">Nota para cocina (opcional)</label>
              <input id="editItemNota" type="text" class="form-control" value="${escapeHtml(String(item.nota || ''))}">
            `}
          </div>
        `,
        showCancelButton: true,
        confirmButtonText: 'Guardar',
        cancelButtonText: 'Cancelar',
        didOpen: () => {
          const inputIds = hasHijos ? ['editItemCantidad', 'editItemObs'] : ['editItemCantidad', 'editItemNota'];
          inputIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
              el.addEventListener(evt, (ev) => ev.stopPropagation());
            });
          });
        },
        preConfirm: () => {
          const cantidad = Number(document.getElementById('editItemCantidad')?.value || 0);
          if(!Number.isFinite(cantidad) || cantidad <= 0){
            Swal.showValidationMessage('La cantidad debe ser mayor a 0');
            return false;
          }

          if (hasHijos) {
            const obs = String(document.getElementById('editItemObs')?.value || '').trim();
            const hijosSel = Array.from(document.querySelectorAll('.edit-item-hijo:checked'))
              .map(ch => String(ch.value || '').trim())
              .filter(Boolean);
            const mapLabel = new Map(hijos.map(h => [String(h.key), String(h.label || '').trim()]));
            const nombresSel = hijosSel.map(k => mapLabel.get(k) || '').filter(Boolean);
            const parts = [...nombresSel];
            if (obs) parts.push(`Obs. ${obs}`);
            return { cantidad, nota: parts.join(' / ') };
          }

          const nota = String(document.getElementById('editItemNota')?.value || '').trim();
          return { cantidad, nota };
        }
      });
    });
    if(!result.isConfirmed) return;

    try{
      const resp = await fetch(`/api/mesas/items/${item.id}`, {
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(result.value)
      });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error || 'No se pudo editar el item');
      await cargarPedido(pedidoActual.id);
      Swal.fire({icon:'success', title:'Item actualizado'});
    }catch(err){
      Swal.fire({icon:'error', title: err.message || 'No se pudo editar el item'});
    }
  });

  // Eliminar item del pedido (solo estado pendiente)
  // Relacionado con: routes/mesas.js (DELETE /api/mesas/items/:itemId)
  $(document).on('click', '[data-action="eliminar-item"]', async function(e){
    e.preventDefault();
    const idx = Number($(this).data('idx'));
    const item = items[idx];
    if(!item || !item.id) return;
    if(String(item.estado || '').toLowerCase() !== 'pendiente'){
      return Swal.fire({icon:'info', title:'Solo puedes eliminar items pendientes'});
    }
    
    const confirmacion = await Swal.fire({
      title: '¿Eliminar producto?',
      text: `¿Está seguro de eliminar ${item.producto_nombre || item.nombre || 'este producto'}?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sí, eliminar',
      cancelButtonText: 'Cancelar'
    });
    
    if(!confirmacion.isConfirmed) return;
    
    try{
      const resp = await fetch(`/api/mesas/items/${item.id}`, { method:'DELETE' });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error || 'Error al eliminar');
      await cargarPedido(pedidoActual.id);
      Swal.fire({icon:'success', title:'Producto eliminado'});
    }catch(err){
      Swal.fire({icon:'error', title: err.message || 'No se pudo eliminar el producto'});
    }
  });

  // Cancelar item del pedido desde mesa (mesero/admin)
  // Relacionado con: routes/mesas.js (PUT /api/mesas/items/:itemId/cancelar)
  $(document).on('click', '[data-action="cancelar-item"]', async function(e){
    e.preventDefault();
    const idx = Number($(this).data('idx'));
    const item = items[idx];
    if(!item || !item.id) return;
    if(!isItemAnulable(item.estado)){
      return Swal.fire({icon:'info', title:'Este item no se puede cancelar en su estado actual'});
    }

    const confirmacion = await Swal.fire({
      title: '¿Cancelar producto?',
      text: `Se cancelará ${item.producto_nombre || item.nombre || 'este producto'} y se verá en Cocina como rechazado.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sí, cancelar',
      cancelButtonText: 'No'
    });
    if(!confirmacion.isConfirmed) return;

    try{
      const resp = await fetch(`/api/mesas/items/${item.id}/cancelar`, { method:'PUT', headers:{'Content-Type':'application/json'} });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error || 'No se pudo cancelar el item');
      await cargarPedido(pedidoActual.id);
      Swal.fire({icon:'success', title:'Producto cancelado'});
    }catch(err){
      Swal.fire({icon:'error', title: err.message || 'No se pudo cancelar el producto'});
    }
  });

  // Enviar todos los items pendientes a cocina
  $('#btnEnviarCocina').on('click', async function(){
    try{
      const pendientes = items.filter(i => i.estado === 'pendiente');
      if(pendientes.length === 0){
        return Swal.fire({icon:'info', title:'No hay items pendientes para enviar'});
      }
      const itemIdsEnviados = pendientes.map(it => Number(it.id)).filter(n => Number.isFinite(n) && n > 0);
      let printWindow = null;
      if (autoListoComanda && !imprimeServidor) {
        // Abrimos ventana antes de awaits para evitar bloqueo de popup por el navegador.
        printWindow = window.open('about:blank', '_blank');
      }
      for(const it of pendientes){
        await fetch(`/api/mesas/items/${it.id}/enviar`, { method:'PUT' });
      }

      // Modo cocina sin dispositivo:
      // - imprimir comanda automáticamente al enviar
      if (autoListoComanda && pedidoActual && pedidoActual.id && itemIdsEnviados.length > 0) {
        if (imprimeServidor) {
          const rPrint = await fetch(`/api/mesas/pedidos/${encodeURIComponent(pedidoActual.id)}/comanda/imprimir-servidor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_ids: itemIdsEnviados })
          });
          const dPrint = await rPrint.json().catch(() => ({}));
          if(!rPrint.ok) throw new Error(dPrint.error || 'No se pudo imprimir en servidor');
        } else {
          const query = new URLSearchParams({
            item_ids: itemIdsEnviados.join(','),
            auto_print: '1'
          });
          const urlComanda = `/api/mesas/pedidos/${encodeURIComponent(pedidoActual.id)}/comanda?${query.toString()}`;
          if (printWindow && !printWindow.closed) {
            try { printWindow.location.href = urlComanda; } catch (_) {}
          } else {
            // Fallback si el popup fue bloqueado.
            window.open(urlComanda, '_blank');
          }
        }
      }

      await cargarPedido(pedidoActual.id);
      Swal.fire({
        icon:'success',
        title: autoListoComanda ? 'Comanda impresa y pedido en Listos' : 'Enviado a cocina'
      });
    }catch(err){
      Swal.fire({icon:'error', title:'No se pudo enviar a cocina'});
    }
  });

  // Mover pedido a otra mesa (handler compartido)
  async function handleMoverMesa(){
    try{
      // Obtener mesas disponibles
      const resp = await fetch('/api/mesas/listar');
      const mesas = await resp.json();
      const libres = mesas.filter(m => (m.pedidos_abiertos||0) === 0 && m.id !== pedidoActual.mesa_id);
      if(libres.length === 0){
        return Swal.fire({ icon:'info', title:'No hay mesas libres' });
      }

      const options = libres.reduce((acc, m) => { acc[m.id] = `Mesa ${m.numero}${m.descripcion? ' - '+m.descripcion:''}`; return acc; }, {});
      const { value: destino } = await runWithOffcanvasHidden(async () => {
        return await Swal.fire({ title:'Mover a mesa', input:'select', inputOptions: options, inputPlaceholder:'Seleccione mesa destino', showCancelButton:true });
      });
      if(!destino) return;

      const r = await fetch(`/api/mesas/pedidos/${pedidoActual.id}/mover`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mesa_destino_id: Number(destino) }) });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error||'No se pudo mover el pedido');

      // Actualizar etiqueta de mesa y recargar items
      const mesaSel = libres.find(m => m.id === Number(destino));
      if(mesaSel){ $('#pedidoMesa').text(mesaSel.numero); }
      await cargarPedido(pedidoActual.id);
      Swal.fire({ icon:'success', title:'Pedido movido' });
    }catch(err){
      Swal.fire({ icon:'error', title: err.message });
    }
  }

  $('#btnMoverMesa').on('click', handleMoverMesa);
  $('#btnMoverMesaHeader').on('click', handleMoverMesa);

  // ====== Estado en vivo de mesas (sin recargar) ======
  async function refreshMesas() {
    try {
      const resp = await fetch('/api/mesas/listar');
      const mesas = await resp.json();
      if (!Array.isArray(mesas)) return;
      mesas.forEach(m => {
        const card = document.querySelector(`.mesa-card[data-mesa-id="${m.id}"]`);
        if (!card) return;
        const badge = card.querySelector('.estado-badge');
        if (badge) {
          badge.textContent = m.estado;
          badge.classList.remove('bg-success','bg-warning','bg-secondary');
          badge.classList.add(m.estado === 'libre' ? 'bg-success' : (m.estado === 'ocupada' ? 'bg-warning' : 'bg-secondary'));
        }
      });
    } catch (_) { /* ignorar errores de red */ }
  }

  // refrescar cada 3s
  setInterval(refreshMesas, 3000);
  // primera carga
  refreshMesas();

  // Facturar pedido
  $('#btnFacturarPedido').on('click', async function(){
    try{
      const cliente = await runWithOffcanvasHidden(() => seleccionarClienteConBusqueda());
      if(!cliente) return; // cancelado
      const cliente_id = cliente.id;

      // Total del pedido basado en items actuales (mismo cálculo del render)
      const totalPedido = (items || []).reduce((acc, it) => {
        if (isItemExcluidoDeTotal(it.estado)) return acc;
        const cantidad = Number(it.cantidad || 0);
        const precio = Number((it.precio_unitario != null ? it.precio_unitario : it.precio) || 0);
        const subtotal = Number(it.subtotal != null ? it.subtotal : (cantidad * precio));
        return acc + subtotal;
      }, 0);

      // Modal de pago mixto (permite 1 o varios medios)
      const pagos = await runWithOffcanvasHidden(async () => {
        return await pedirPagosMixtos(totalPedido);
      });
      if(!pagos) return;

      const resp = await fetch(`/api/mesas/pedidos/${pedidoActual.id}/facturar`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ cliente_id, pagos })
      });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error||'Error al facturar');
      // Si está activo "factura en servidor", no abrimos vista de navegador.
      const cfgResp = await fetch('/api/facturas/config/impresion');
      const cfg = await cfgResp.json().catch(() => ({}));
      const facturaServer = !!cfg?.factura_imprime_servidor;
      if (facturaServer) {
        const pResp = await fetch(`/api/facturas/${encodeURIComponent(data.factura_id)}/imprimir-servidor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const pData = await pResp.json().catch(() => ({}));
        if (!pResp.ok) throw new Error(pData.error || 'No se pudo imprimir factura en servidor');
        await Swal.fire({ icon:'success', title:`Factura impresa en servidor (${pData.copias || 1} copia/s)` });
        window.location.href = '/mesas';
        return;
      }
      // En Mesas queremos volver a /mesas (no al index) desde la vista de impresión.
      window.location.href = `/api/facturas/${data.factura_id}/imprimir?return_to=${encodeURIComponent('/mesas')}`;
    }catch(err){
      Swal.fire({icon:'error', title: err.message});
    }
  });

  // Ocultar temporalmente el panel lateral (offcanvas) durante modales para evitar bloquear copiar/pegar
  async function runWithOffcanvasHidden(action){
    const el = document.getElementById('canvasPedido');
    const isShown = (node) => !!node && (node.classList.contains('show') || node.classList.contains('showing'));

    const waitFor = (node, eventName, timeoutMs = 1200) => {
      return new Promise(resolve => {
        if (!node) return resolve();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { node.removeEventListener(eventName, onEvt); } catch (_) {}
          if (t) clearTimeout(t);
          resolve();
        };
        const onEvt = () => finish();
        node.addEventListener(eventName, onEvt, { once: true });
        const t = setTimeout(finish, timeoutMs);
      });
    };

    const wasOpen = isShown(el);
    if (wasOpen) {
      try {
        // Usar la instancia real (evita conflictos si Bootstrap creó otra internamente)
        bootstrap.Offcanvas.getOrCreateInstance(el).hide();
      } catch (_) {
        try { canvas.hide(); } catch (_2) { /* noop */ }
      }
      // Esperar al evento real (evita que el offcanvas siga "capturando" foco detrás del SweetAlert)
      await waitFor(el, 'hidden.bs.offcanvas', 1200);
    }
    try{
      const result = await action();
      return result;
    } finally {
      if(wasOpen){
        try {
          bootstrap.Offcanvas.getOrCreateInstance(el).show();
        } catch (_) {
          try { canvas.show(); } catch (_2) { /* noop */ }
        }
      }
    }
  }

  function buildPedidoResumenHtml(){
    let total = 0;
    const rows = (items||[]).filter(it => !isItemExcluidoDeTotal(it.estado)).map(it => {
      const cantidad = Number(it.cantidad||0);
      const precio = Number((it.precio_unitario!=null?it.precio_unitario:it.precio)||0);
      const subtotal = Number(it.subtotal!=null?it.subtotal:(cantidad*precio));
      total += subtotal;
      const nombre = it.producto_nombre || it.nombre || '';
      return `<tr><td>${nombre}</td><td class="text-end">${cantidad}</td><td class="text-end">$${subtotal.toLocaleString('es-CO')}</td></tr>`;
    }).join('');
    return `
      <div class="border rounded p-2 mt-2" id="contenedorResumen" style="display:none;max-height:220px;overflow:auto;">
        <table class="table table-sm mb-2">
          <thead class="table-light"><tr><th>Producto</th><th class="text-end">Cant</th><th class="text-end">Subt</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot class="table-light"><tr><th colspan="2" class="text-end">Total</th><th class="text-end">$${total.toLocaleString('es-CO')}</th></tr></tfoot>
        </table>
      </div>`;
  }

  // -- Helpers de cliente: búsqueda por nombre con default "Consumidor final" --
  async function getConsumidorFinalOrNull(){
    // Buscar "Consumidor final" por nombre (sin crear nada).
    // Relacionado con: requisito -> mesero NO puede crear cliente al facturar.
    try{
      const r = await fetch('/api/clientes/buscar?q=consumidor%20final');
      const list = await r.json();
      const cf = (Array.isArray(list) ? list : []).find(c => (c.nombre||'').toLowerCase() === 'consumidor final');
      return cf || null;
    }catch(_){
      return null;
    }
  }

  async function getOrCreateConsumidorFinal(){
    // Buscar o crear el cliente por defecto "Consumidor final" (solo para admin, no mesero).
    // Relacionado con:
    // - routes/clientes.js (POST /api/clientes)
    // - public/js/mesas.js (selector de cliente)
    // Nota: para mesero usaremos getConsumidorFinalOrNull() y evitaremos crear.
    const found = await getConsumidorFinalOrNull();
    if(found) return found;
    try{
      const r = await fetch('/api/clientes', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ nombre: 'Consumidor final' })
      });
      if(r.ok){
        const cf = await r.json();
        return { id: cf.id, nombre: 'Consumidor final' };
      }
    }catch(_){/* noop */}
    // Último recurso: retornar marcador (admin podrá elegir otro cliente)
    return { id: null, nombre: 'Consumidor final' };
  }

  async function buscarClientesPorNombre(q){
    const resp = await fetch(`/api/clientes/buscar?q=${encodeURIComponent(q)}`);
    if(!resp.ok) return [];
    return await resp.json();
  }

  async function seleccionarClienteConBusqueda(){
    const isMesero = (userRole === 'mesero');
    // Mesero: NO crear clientes. Admin: puede crear y también autogenerar "Consumidor final" si falta.
    // Relacionado con: requisito solicitado
    const defaultCliente = isMesero ? await getConsumidorFinalOrNull() : await getOrCreateConsumidorFinal();
    let seleccionado = defaultCliente || null;
    // Bucle para permitir crear cliente y luego usarlo
    // Confirm = Usar cliente; Deny = Crear cliente; Cancel = cancelar flujo
    // Tras crear, retornamos el nuevo cliente directamente
    // Diseño con buscador y lista, y default Consumidor final
    /* eslint no-constant-condition: 0 */
    while(true){
      const result = await Swal.fire({
        title: 'Seleccionar cliente',
        html: `
          <div class="mb-2 text-start small text-muted">
            Predeterminado:
            <strong id="cfNombre">${seleccionado ? seleccionado.nombre : '— (selecciona un cliente)'}</strong>
          </div>
          ${isMesero ? `<div class="alert alert-info py-2 px-3 small mb-2">
            <i class="bi bi-info-circle me-1"></i>Como <strong>mesero</strong>, no puedes crear clientes desde Facturar. Busca y selecciona uno existente.
          </div>` : ''}
          <div class="input-group mb-2">
            <span class="input-group-text"><i class="bi bi-search"></i></span>
            <input id="buscarClienteMesa" class="form-control" placeholder="Buscar cliente por nombre o teléfono..." />
          </div>
          <div id="resultadosClientesMesa" class="list-group" style="max-height:260px;overflow:auto"></div>
          <button id="btnToggleResumen" class="btn btn-outline-secondary btn-sm mt-2" type="button"><i class="bi bi-receipt"></i> Ver pedido</button>
          ${buildPedidoResumenHtml()}
        `,
        showCancelButton: true,
        // Mesero: ocultar la opción "Crear cliente"
        // Relacionado con: requisito solicitado
        showDenyButton: !isMesero,
        confirmButtonText: 'Usar cliente',
        denyButtonText: 'Crear cliente',
        preConfirm: () => {
          // Validación: debe existir un cliente seleccionado con id válido.
          if (!seleccionado || !seleccionado.id) {
            Swal.showValidationMessage('Seleccione un cliente existente.');
            return false;
          }
          return seleccionado;
        },
        didOpen: async () => {
          const $input = document.getElementById('buscarClienteMesa');
          const $list = document.getElementById('resultadosClientesMesa');
          // Permitir copiar/pegar sin interferencia de atajos globales
          const allowClipboard = (el) => {
            ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
              el.addEventListener(evt, (e) => {
                e.stopPropagation(); // no afectar por manejadores globales
              });
            });
          };
          allowClipboard($input);
          // Prefill lista con Consumidor final (si existe)
          $list.innerHTML = '';
          if (seleccionado && seleccionado.id) {
            const li = document.createElement('a');
            li.href = '#'; li.className = 'list-group-item list-group-item-action active';
            li.textContent = `${seleccionado.nombre} (predeterminado)`;
            li.onclick = (e)=>{ e.preventDefault(); marcarSeleccion(li, seleccionado); };
            $list.appendChild(li);
          } else {
            const empty = document.createElement('div');
            empty.className = 'list-group-item text-muted';
            empty.innerHTML = '<i class="bi bi-search me-1"></i>Escribe para buscar y seleccionar un cliente...';
            $list.appendChild(empty);
          }

          // Toggle resumen
          const btnRes = document.getElementById('btnToggleResumen');
          const contRes = document.getElementById('contenedorResumen');
          if(btnRes && contRes){
            btnRes.addEventListener('click', ()=>{
              const visible = contRes.style.display !== 'none';
              contRes.style.display = visible ? 'none' : 'block';
              btnRes.classList.toggle('active', !visible);
              btnRes.innerHTML = !visible ? '<i class="bi bi-receipt"></i> Ocultar pedido' : '<i class="bi bi-receipt"></i> Ver pedido';
            });
          }

          let to;
          function marcarSeleccion(el, cliente){
            seleccionado = cliente;
            document.querySelectorAll('#resultadosClientesMesa .list-group-item').forEach(x=>x.classList.remove('active'));
            el.classList.add('active');
            document.getElementById('cfNombre').textContent = cliente.nombre;
          }
          async function doSearch(){
            const q = ($input.value||'').trim();
            if(q.length < 2){ return; }
            const res = await buscarClientesPorNombre(q);
            $list.innerHTML = '';
            if(res.length === 0){
              const empty = document.createElement('div');
              empty.className = 'list-group-item text-muted';
              empty.textContent = 'Sin resultados';
              $list.appendChild(empty);
              return;
            }
            res.forEach(c => {
              const a = document.createElement('a');
              a.href = '#'; a.className = 'list-group-item list-group-item-action';
              a.innerHTML = `<div><strong>${c.nombre}</strong></div><div class="small text-muted">${c.telefono||''} ${c.direccion? '• '+c.direccion:''}</div>`;
              a.onclick = (e)=>{ e.preventDefault(); marcarSeleccion(a, c); };
              $list.appendChild(a);
            });
          }
          $input.addEventListener('input', ()=>{ clearTimeout(to); to = setTimeout(doSearch, 250); });
        }
      });

      if(result.isDenied){
        // Crear cliente nuevo
        const nuevo = await Swal.fire({
          title: 'Nuevo cliente',
          html: `
            <div class="text-start">
              <div class="mb-2">
                <label class="form-label small">Nombre</label>
                <input id="nuevoCliNombre" class="form-control" placeholder="Nombre del cliente" />
              </div>
              <div class="mb-2">
                <label class="form-label small">Teléfono (opcional)</label>
                <input id="nuevoCliTel" class="form-control" placeholder="Teléfono" />
              </div>
              <div class="mb-2">
                <label class="form-label small">Dirección (opcional)</label>
                <input id="nuevoCliDir" class="form-control" placeholder="Dirección" />
              </div>
            </div>
          `,
          showCancelButton: true,
          confirmButtonText: 'Guardar',
          didOpen: () => {
            // Permitir copiar/pegar en todos los inputs del modal
            ['nuevoCliNombre','nuevoCliTel','nuevoCliDir'].forEach(id => {
              const el = document.getElementById(id);
              if(!el) return;
              ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
                el.addEventListener(evt, (e) => {
                  e.stopPropagation();
                });
              });
            });
          },
          preConfirm: () => {
            const nombre = (document.getElementById('nuevoCliNombre').value||'').trim();
            const telefono = (document.getElementById('nuevoCliTel').value||'').trim();
            const direccion = (document.getElementById('nuevoCliDir').value||'').trim();
            if(!nombre){
              Swal.showValidationMessage('El nombre es requerido');
              return false;
            }
            return { nombre, telefono, direccion };
          }
        });
        if(nuevo.isConfirmed){
          const body = nuevo.value;
          try{
            const resp = await fetch('/api/clientes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            if(!resp.ok){
              const e = await resp.json();
              throw new Error(e.error || 'Error al crear cliente');
            }
            const data = await resp.json();
            const creado = { id: data.id, nombre: body.nombre, telefono: body.telefono, direccion: body.direccion };
            await Swal.fire({ icon:'success', title:'Cliente creado' });
            return creado;
          }catch(err){
            await Swal.fire({ icon:'error', title: err.message||'Error al crear cliente' });
            continue; // volver al selector
          }
        } else {
          continue; // volver al selector
        }
      }

      if(result.isConfirmed){
        // La validación de selección se hace en preConfirm y viene en result.value
        return result.value;
      }
      // Cancelado
      return null;
    }
  }

  // Clicks en tarjetas de mesa
  $('#gridMesas').on('click', '.btnAbrirPedido', function(){
    const card = $(this).closest('.card');
    const mesaId = card.data('mesa-id');
    const titulo = card.find('.card-title').text().replace('Mesa ','');
    abrirPedido(mesaId, titulo);
  });

  // Liberar mesa desde tarjeta
  $('#gridMesas').on('click', '.btnLiberarMesa', async function(){
    const card = $(this).closest('.card');
    const mesaId = card.data('mesa-id');
    const mesaNum = card.find('.card-title').text().replace('Mesa ', '');
    const ok = await Swal.fire({ title:`Liberar mesa ${mesaNum}?`, text:'Solo si no tiene items activos', icon:'warning', showCancelButton:true, confirmButtonText:'Sí, liberar' });
    if(!ok.isConfirmed) return;
    try{
      const r = await fetch(`/api/mesas/${mesaId}/liberar`, { method:'PUT' });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error||'No se pudo liberar');
      Swal.fire({ icon:'success', title:'Mesa liberada' }).then(()=> location.reload());
    }catch(err){
      Swal.fire({ icon:'error', title: err.message });
    }
  });

  // Liberar desde header del offcanvas
  $('#btnLiberarMesaHeader').on('click', async function(){
    const ok = await Swal.fire({ title:`Liberar mesa ${$('#pedidoMesa').text()}?`, text:'Solo si no tiene items activos', icon:'warning', showCancelButton:true, confirmButtonText:'Sí, liberar' });
    if(!ok.isConfirmed) return;
    try{
      const r = await fetch(`/api/mesas/${pedidoActual.mesa_id}/liberar`, { method:'PUT' });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error||'No se pudo liberar');
      Swal.fire({ icon:'success', title:'Mesa liberada' }).then(()=> location.reload());
    }catch(err){
      Swal.fire({ icon:'error', title: err.message });
    }
  });

  // Limpiar items rechazados/cancelados del pedido actual
  // Relacionado con:
  // - routes/mesas.js (DELETE /api/mesas/pedidos/:pedidoId/items/rechazados)
  // - views/mesas.ejs (btnLimpiarRechazadosHeader)
  $('#btnLimpiarRechazadosHeader').on('click', async function(){
    if(!pedidoActual || !pedidoActual.id) return;
    const ok = await Swal.fire({
      title: '¿Limpiar rechazados?',
      text: 'Se eliminarán del pedido los items rechazados/cancelados.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sí, limpiar',
      cancelButtonText: 'Cancelar'
    });
    if(!ok.isConfirmed) return;
    try{
      const r = await fetch(`/api/mesas/pedidos/${pedidoActual.id}/items/rechazados`, { method:'DELETE' });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || 'No se pudo limpiar');

      // Si el pedido quedó vacío y fue cancelado, cerramos panel y refrescamos tarjetas.
      // Relacionado con: routes/mesas.js (pedido_cancelado=true cuando no quedan items)
      if (data && data.pedido_cancelado) {
        try { bootstrap.Offcanvas.getOrCreateInstance(document.getElementById('canvasPedido')).hide(); } catch (_) {}
        await refreshMesas();
      } else {
        await cargarPedido(pedidoActual.id);
      }
      Swal.fire({ icon:'success', title:'Rechazados limpiados' });
    }catch(err){
      Swal.fire({ icon:'error', title: err.message || 'No se pudo limpiar' });
    }
  });

  // Ver pedido: reutiliza abrirPedido (recupera si existe, o crea si no)
  $('#gridMesas').on('click', '.btnVerPedido', function(){
    const card = $(this).closest('.card');
    const mesaId = card.data('mesa-id');
    const titulo = card.find('.card-title').text().replace('Mesa ','');
    abrirPedido(mesaId, titulo);
  });

  // Crear nueva mesa (rápida)
  $('#btnNuevaMesa').on('click', async function(){
    const { value: numero } = await Swal.fire({ title:'Número de mesa', input:'text', showCancelButton:true });
    if(!numero) return;
    const { value: descripcion } = await Swal.fire({ title:'Descripción', input:'text', showCancelButton:true });
    const resp = await fetch('/api/mesas/crear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ numero, descripcion }) });
    if(!resp.ok){ const err = await resp.json(); return Swal.fire({icon:'error', title: err.error||'Error'}); }
    Swal.fire({icon:'success', title:'Mesa creada'}).then(()=> location.reload());
  });

  function escapeHtml(s){
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Editar mesa
  $('#gridMesas').on('click', '.btnEditarMesa', async function(e){
    e.preventDefault();
    const card = $(this).closest('.card')[0];
    if(!card) return;

    const mesaId = card.getAttribute('data-mesa-id');
    const numeroActual = card.dataset.mesaNumero || '';
    const descripcionActual = card.dataset.mesaDescripcion || '';
    const estadoActual = card.dataset.mesaEstado || 'libre';

    const result = await Swal.fire({
      title: 'Editar mesa',
      html: `
        <div class="text-start">
          <label class="form-label small">Número</label>
          <input id="editMesaNumero" class="form-control mb-2" value="${escapeHtml(numeroActual)}" />
          <label class="form-label small">Descripción</label>
          <input id="editMesaDescripcion" class="form-control mb-2" value="${escapeHtml(descripcionActual)}" />
          <label class="form-label small">Estado</label>
          <select id="editMesaEstado" class="form-select">
            <option value="libre">libre</option>
            <option value="ocupada">ocupada</option>
            <option value="reservada">reservada</option>
            <option value="bloqueada">bloqueada</option>
          </select>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Guardar',
      didOpen: () => {
        const sel = document.getElementById('editMesaEstado');
        if(sel) sel.value = estadoActual;
        ['editMesaNumero','editMesaDescripcion'].forEach(id => {
          const el = document.getElementById(id);
          if(!el) return;
          ['keydown','keyup','keypress','paste','copy','cut','contextmenu'].forEach(evt => {
            el.addEventListener(evt, (ev) => ev.stopPropagation());
          });
        });
      },
      preConfirm: () => {
        const numero = (document.getElementById('editMesaNumero').value || '').trim();
        const descripcion = (document.getElementById('editMesaDescripcion').value || '').trim();
        const estado = (document.getElementById('editMesaEstado').value || '').trim();
        if(!numero){
          Swal.showValidationMessage('El número es requerido');
          return false;
        }
        return { numero, descripcion, estado };
      }
    });

    if(!result.isConfirmed) return;
    try{
      const resp = await fetch(`/api/mesas/${mesaId}`, {
        method:'PUT',
        headers:{'Content-Type':'application/json', 'Accept':'application/json'},
        body: JSON.stringify(result.value)
      });
      const contentType = resp.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await resp.json() : { error: await resp.text() };
      if(!resp.ok) throw new Error(data.error || 'Error al editar mesa');

      // Actualizar UI en la tarjeta
      card.dataset.mesaNumero = result.value.numero;
      card.dataset.mesaDescripcion = result.value.descripcion || '';
      card.dataset.mesaEstado = result.value.estado;

      const title = card.querySelector('.card-title');
      if(title) title.textContent = `Mesa ${result.value.numero}`;
      const desc = card.querySelector('p.text-muted');
      if(desc) desc.textContent = result.value.descripcion || '';

      const badge = card.querySelector('.estado-badge');
      if(badge){
        badge.textContent = result.value.estado;
        badge.classList.remove('bg-success','bg-warning','bg-secondary');
        badge.classList.add(result.value.estado === 'libre' ? 'bg-success' : (result.value.estado === 'ocupada' ? 'bg-warning' : 'bg-secondary'));
      }

      Swal.fire({ icon:'success', title:'Mesa actualizada' });
    }catch(err){
      Swal.fire({ icon:'error', title: err.message || 'No se pudo editar la mesa' });
    }
  });

  // Eliminar mesa
  $('#gridMesas').on('click', '.btnEliminarMesa', async function(e){
    e.preventDefault();
    const btn = this;
    if(btn.hasAttribute('disabled')) return;
    const card = $(btn).closest('.card')[0];
    if(!card) return;
    const mesaId = card.getAttribute('data-mesa-id');
    const numero = card.dataset.mesaNumero || card.querySelector('.card-title')?.textContent?.replace('Mesa ','') || '';

    const confirmacion = await Swal.fire({
      title: `¿Eliminar mesa ${numero}?`,
      text: 'Esta acción no se puede deshacer.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sí, eliminar',
      cancelButtonText: 'Cancelar'
    });
    if(!confirmacion.isConfirmed) return;

    try{
      const resp = await fetch(`/api/mesas/${mesaId}`, { method:'DELETE', headers:{ 'Accept':'application/json' } });
      const contentType = resp.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await resp.json() : { error: await resp.text() };
      if(!resp.ok) throw new Error(data.error || 'Error al eliminar mesa');

      // Quitar tarjeta del grid
      const wrapper = $(card).closest('.col-6');
      if(wrapper.length) wrapper.remove();
      else $(card).remove();

      Swal.fire({ icon:'success', title:'Mesa eliminada' });
    }catch(err){
      Swal.fire({ icon:'error', title: err.message || 'No se pudo eliminar la mesa' });
    }
  });
});


