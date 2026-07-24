// ============================================================================
// agricef-fila-shared.js — módulo compartilhado entre a página (index.html) e o
// Service Worker (sw.js). Script clássico (sem import/export ES module) — carregado via
// <script src="agricef-fila-shared.js"> na página e via importScripts() no SW, pra
// funcionar sem build step nos dois contextos. NÃO usa document/window: o Service Worker
// não tem DOM. Efeitos colaterais de UI (toast, badge) ficam de fora, entregues via um
// objeto `hooks` opcional que cada contexto preenche do seu jeito.
//
// Fix#FilaOffline (Background Sync): antes a fila só reenviava enquanto a aba ficava
// aberta (localStorage + setInterval). Migrado para IndexedDB porque um Service Worker
// não acessa localStorage — só assim o navegador consegue reenviar em segundo plano
// mesmo com o app fechado (Android/Chrome; no iOS não existe equivalente, ver index.html).
// ============================================================================

const API = 'https://script.google.com/macros/s/AKfycbzqXA7fg1-IEQbbp4Zggwy9FMzAXaUOfEbjpppZslJLu9f0TbiMelaOroHTe7qYencItw/exec';
const FILA_MAX_TENTATIVAS = 20; // mais tolerante — falhas intermitentes do Apps Script
const TIPOS_FECHAMENTO_FILA = ['FECHAMENTO', 'TERMINO_RETRABALHO', 'TERMINO_PARADA'];
const FILA_DB_NAME = 'AgricefOfflineDB';
const FILA_DB_VERSION = 1;
const FILA_LEASE_MS = 60000; // janela de "reivindicação" de um item — evita página e SW processarem o mesmo item ao mesmo tempo

function gerarRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'rid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// ===================== INDEXEDDB — helpers de baixo nível =====================

function _abrirFilaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILA_DB_NAME, FILA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('fila'))   db.createObjectStore('fila', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('falhas')) db.createObjectStore('falhas', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function _filaGetAll() {
  const db = await _abrirFilaDB();
  return _reqToPromise(db.transaction('fila', 'readonly').objectStore('fila').getAll());
}

async function _filaPut(item) {
  const db = await _abrirFilaDB();
  return _reqToPromise(db.transaction('fila', 'readwrite').objectStore('fila').put(item));
}

async function _filaDelete(id) {
  const db = await _abrirFilaDB();
  return _reqToPromise(db.transaction('fila', 'readwrite').objectStore('fila').delete(id));
}

async function _falhasPut(item) {
  const db = await _abrirFilaDB();
  return _reqToPromise(db.transaction('falhas', 'readwrite').objectStore('falhas').put(item));
}

// Reivindica um item pra processamento exclusivo dentro de UMA transação (get+put atômicos —
// nenhum outro contexto consegue ler um estado intermediário). Devolve o registro FRESCO do
// banco (não um snapshot antigo) se conseguiu reivindicar; null se outro contexto já está
// processando (lease ainda válido) ou se o item já não existe mais (sincronizado/removido por
// outro contexto entre o snapshot que o chamador tinha e agora).
async function _reivindicarItem(id) {
  const db = await _abrirFilaDB();
  const tx = db.transaction('fila', 'readwrite');
  const store = tx.objectStore('fila');
  const atual = await _reqToPromise(store.get(id));
  if (!atual) return null;
  const agora = Date.now();
  if (atual._status === 'in-flight' && atual._leaseUntil > agora) return null;
  atual._status = 'in-flight';
  atual._leaseUntil = agora + FILA_LEASE_MS;
  await _reqToPromise(store.put(atual));
  return atual;
}

// Libera a reivindicação sem remover o item (falha transitória — mantém na fila, tentativas
// atualizadas, pronto pra ser reivindicado de novo na próxima passada).
async function _liberarItem(item, novasTentativas) {
  item._tentativas = novasTentativas;
  item._status = 'pending';
  item._leaseUntil = 0;
  await _filaPut(item);
}

// ===================== FILA — API pública (usada pela página e pelo SW) =====================

// Identidade estável de um item da fila offline — usa requestId quando presente (itens salvos
// após a introdução da idempotência); cai para _salvoEm (timestamp ISO com precisão de ms,
// gerado no momento do salvarOffline) em itens legados sem requestId.
function _idItemFila(item) {
  return item.requestId || item._salvoEm;
}

async function salvarOffline(p) {
  const _salvoEm = new Date().toISOString();
  const id = p.requestId || _salvoEm;
  const item = { ...p, id, _tentativas: 0, _salvoEm, _status: 'pending', _leaseUntil: 0 };
  await _filaPut(item);
  return item;
}

// Move um item da fila para falhas permanentes: grava em "falhas", remove de "fila" e dispara
// e-mail de alerta. Usado tanto para esgotamento de tentativas (falha transitória persistente)
// quanto para rejeição de validação (erro determinístico — reenviar não resolve).
async function _moverParaFalhasPermanentes(item, motivo, hooks) {
  const itemFalho = { ...item, _falhouEm: new Date().toISOString(), _motivo: motivo };
  await _falhasPut(itemFalho);
  await _filaDelete(item.id);
  console.error('AGRICEF: apontamento movido para fila de falhas permanentes —', motivo, item);
  if (hooks && hooks.onFalhaPermanente) { try { hooks.onFalhaPermanente(itemFalho, motivo); } catch (e) {} }
  try {
    await fetch(API + '?action=notificarFalhaPermanente&item=' + encodeURIComponent(JSON.stringify(itemFalho)));
  } catch (e) {}
}

// ===================== API =====================

async function postAPI(obj) {
  // GET com payload na URL — único método que funciona de forma confiável no
  // Google Apps Script (POST perde o body no redirect 302 em browsers mobile).
  // _t=timestamp garante que o CDN do Google não sirva resposta cacheada.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000); // timeout 55s — GAS lock pode levar até 15s + processamento
  try {
    const params = new URLSearchParams({ payload: JSON.stringify(obj), _t: Date.now() });
    const res = await fetch(API + '?' + params.toString(), { signal: controller.signal });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('Resposta inválida do servidor: ' + text.substring(0, 200)); }
  } finally {
    clearTimeout(timer);
  }
}

// Retorna true (confirmado registrado), false (confirmado NÃO registrado) ou null (não foi
// possível confirmar — trata como incerto, nunca como "pode descartar").
async function verificarFechamentoRegistrado(abertoId, tipo) {
  if (!abertoId || !tipo) return false;
  try {
    const url = API + '?action=verificarFechamentoRegistrado'
      + '&abertoId=' + encodeURIComponent(abertoId)
      + '&tipo=' + encodeURIComponent(tipo);
    const data = await (await fetch(url)).json();
    if (data.registrado === true) return true;
    if (data.registrado === false) return false;
    return null; // erro no servidor ao verificar — incerto
  } catch {
    return null; // falha de rede ao verificar — incerto
  }
}

// ===================== NÚCLEO DA SINCRONIZAÇÃO =====================
// Mesma árvore de decisão que existia em _sincronizarFilaImpl antes da migração pra
// IndexedDB — só a forma de ler/escrever a fila mudou (por registro, não mais o array
// inteiro de uma vez, o que elimina a necessidade do antigo "merge seguro" contra
// sobrescrita de itens novos adicionados em paralelo: cada item agora é independente).
//
// hooks (todos opcionais): onSincronizado(n), onFalhaPermanente(item,motivo),
// onFalhaManual(restantes) — só quando manual=true e nada sincronizou.
async function _sincronizarFilaImplCore(manual, hooks) {
  hooks = hooks || {};
  const snapshot = await _filaGetAll();
  if (!snapshot.length) return { sincronizados: 0, restantes: 0 };

  let sincronizados = 0;
  for (const stale of snapshot) {
    const item = await _reivindicarItem(stale.id);
    if (!item) continue; // já sincronizado/removido por outro contexto, ou outro contexto processando agora

    const tentativas = (item._tentativas || 0) + 1;
    if (tentativas > FILA_MAX_TENTATIVAS) {
      await _moverParaFalhasPermanentes(item, 'esgotou ' + FILA_MAX_TENTATIVAS + ' tentativas de reenvio', hooks);
      continue;
    }

    try {
      const itemSemMeta = { ...item };
      delete itemSemMeta.id;
      delete itemSemMeta._tentativas;
      delete itemSemMeta._salvoEm;
      delete itemSemMeta._status;
      delete itemSemMeta._leaseUntil;
      const d = await postAPI(itemSemMeta);

      if (d.success) {
        sincronizados++;
        await _filaDelete(item.id);
      } else if (d.jaFechado || (d.jaAberto && d.bloqueado)) {
        // Este item específico já foi aplicado com sucesso numa tentativa anterior cuja
        // resposta não chegou ao cliente (retry após falha de rede) — nada a fazer, remove
        // da fila. Não é erro: é o próprio requestId confirmando idempotência.
        sincronizados++;
        await _filaDelete(item.id);
      } else if (d.semAberto && TIPOS_FECHAMENTO_FILA.includes(item.tipoApontamento)) {
        // Servidor não encontrou abertura correspondente para este fechamento — pode
        // significar (a) já foi aplicado numa tentativa anterior cuja resposta não chegou ao
        // cliente — seguro descartar; ou (b) um erro genuíno. Descartar sem checar PERDERIA o
        // apontamento silenciosamente. Confirma no servidor antes de decidir — nunca assume.
        const confirmacao = await verificarFechamentoRegistrado(item.abertoId, item.tipoApontamento);
        if (confirmacao === true) {
          sincronizados++;
          await _filaDelete(item.id);
        } else {
          // confirmacao === false (genuinamente não registrado) ou null (incerto) — mantém.
          await _liberarItem(item, tentativas);
        }
      } else if (d.incompativel || (d.bloqueado && !d.jaAberto)) {
        // Rejeição determinística (tipo/série/operação incompatível, ou bloqueado por outra
        // abertura genuinamente diferente) — reenviar nunca vai funcionar. Move direto pra
        // falhas permanentes em vez de esperar o limite de tentativas.
        await _moverParaFalhasPermanentes(item, d.message || 'rejeitado pelo servidor', hooks);
      } else {
        // Falha transitória (rede, timeout, lock ocupado) ou erro não classificado — mantém.
        await _liberarItem(item, tentativas);
      }
    } catch {
      await _liberarItem(item, tentativas);
    }
  }

  const restantes = (await _filaGetAll()).length;
  if (sincronizados > 0 && hooks.onSincronizado) { try { hooks.onSincronizado(sincronizados); } catch (e) {} }
  else if (manual && restantes > 0 && hooks.onFalhaManual) { try { hooks.onFalhaManual(restantes); } catch (e) {} }
  return { sincronizados, restantes };
}

// ===================== MIGRAÇÃO DE VERSÃO ANTERIOR (localStorage → IndexedDB) =====================
// Roda uma vez no início da página (não faz sentido no SW — localStorage não existe lá).
// Nunca apaga o localStorage ANTES de confirmar a escrita no IndexedDB — uma falha no meio do
// caminho não pode reproduzir o tipo de perda silenciosa que este projeto existe pra evitar.
async function migrarFilaLegadaSeNecessario() {
  if (typeof localStorage === 'undefined') return; // contexto sem localStorage (Service Worker)
  try {
    const filaLegada = JSON.parse(localStorage.getItem('agricef_fila') || '[]');
    for (const item of filaLegada) {
      const id = item.requestId || item._salvoEm || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      await _filaPut({ ...item, id, _status: 'pending', _leaseUntil: 0 });
    }
    localStorage.removeItem('agricef_fila');

    const falhasLegadas = JSON.parse(localStorage.getItem('agricef_falhas') || '[]');
    for (const item of falhasLegadas) {
      const id = item.requestId || item._salvoEm || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      await _falhasPut({ ...item, id });
    }
    localStorage.removeItem('agricef_falhas');
  } catch (e) {
    console.error('AGRICEF: falha ao migrar fila legada do localStorage — itens legados preservados, tentará de novo no próximo load', e);
  }
}
