// ================================================================
// AGRICEF — Web App Apps Script v4.3 (deploy 15/06/2026)
//
// Colunas da planilha (inalteradas):
//   A  Carimbo de data/hora
//   B  NOME DO OPERADOR
//   C  TIPO DE APONTAMENTO
//   D  TIPO DE OPERAÇÃO 1
//   E  CÓDIGO DO ITEM
//   F  Nº SERIE | IMPLEMENTO | CLIENTE | INTERNO
//   G  QUANTIDADE
//   H  OBSERVAÇÃO 1
//   I  TIPOS DE RETRABALHOS
//   J  Nº DA RNC
//   K  TIPOS DE PARADA
//   L  TIPO DE OPERAÇÃO 2
//   M  TIPO DE OPERAÇÃO DE SET-UP
//   N  OBSERVAÇÃO 2
//   O  OBSERVAÇÃO  ← usado para QTD PLANEJADA
// ================================================================

const SPREADSHEET_ID  = '1KxK9Fk7fqkvEdo71n3hHZnYTaH1m63LEQSsD_YsL_co'; // COPIA DE TESTE - nao e producao

// Rode esta funcao uma vez pelo editor (Executar > autorizarAcesso) para conceder
// as permissoes do projeto novo. So precisa ser feito uma vez.
function autorizarAcesso() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log('Acesso OK: ' + ss.getName());
}
const ABA_RESPOSTAS   = 'Respostas do Formulário 1';
const ABA_ABERTOS     = 'Abertos';
const ABA_OPERADORES  = 'Cadastro_Operadores';
const ABA_SALDO       = 'Saldo_Parcial';
const ABA_SERIES      = 'Cadastro_Series';
const ABA_OPERACOES   = 'Cadastro_Operacoes';
const ABA_ANALISES_IA = 'Analises_IA';
const ABA_JUSTIFICATIVAS = 'Justificativas_Auditoria';
const ABA_IDEMPOTENCY    = 'IdempotencyLog';
const ABA_PARADAS_ANINHADAS = 'Paradas_Aninhadas';
const ABA_HISTORICO = 'Historico'; // arquivamento — mesmo schema de ABA_RESPOSTAS
const ARQUIVAMENTO_MARGEM_DIAS = 30; // não arquiva nada fechado há menos de N dias

// ================================================================
// SCHEMA DE COLUNAS (0-indexed)
// REGRA: nenhum código usa row[N] literal — usa COL_RE.CAMPO ou COL_AB.CAMPO.
// Se uma coluna for adicionada/movida, altere APENAS estes objetos.
// ================================================================
const COL_RE = {
  CARIMBO:         0,  // A  Carimbo de data/hora
  OPERADOR:        1,  // B  NOME DO OPERADOR
  TIPO:            2,  // C  TIPO DE APONTAMENTO
  OPERACAO:        3,  // D  TIPO DE OPERAÇÃO 1
  COD_ITEM:        4,  // E  CÓDIGO DO ITEM
  SERIE:           5,  // F  Nº SERIE | IMPLEMENTO | CLIENTE
  QTD:             6,  // G  QUANTIDADE
  OBS1:            7,  // H  OBSERVAÇÃO 1
  TIPO_RETRAB:     8,  // I  TIPOS DE RETRABALHOS
  NR_RNC:          9,  // J  Nº DA RNC
  TIPO_PARADA:     10, // K  TIPOS DE PARADA
  OPERACAO2:       11, // L  TIPO DE OPERAÇÃO 2
  TIPO_SETUP:      12, // M  TIPO DE OPERAÇÃO DE SET-UP
  OBS2:            13, // N  OBSERVAÇÃO 2
  QTD_PLANEJADA:   14, // O  QTD PLANEJADA
  ABERTO_ID:       15, // P  ID (abertoId AP-XXXXXXXXXX)
  LOTE_SERIES:     16, // Q  LoteSeries JSON (ABERTURA de lote — para reconstrução do Abertos)
  ABERTO_ID_PAI:   17, // R  AbertoId do apontamento (ABERTURA/INÍCIO DE RETRABALHO) que esta
                       //    parada pausou, quando é uma PARADA ANINHADA. Vazio em qualquer
                       //    outro tipo de linha (inclusive parada standalone, sem aninhamento).
  CICLO_ID:        18, // S  cicloId — identidade persistente do ciclo de produção (série+item+
                       //    operação), reaproveitada entre reaberturas de baixa parcial. Nunca
                       //    igual a ABERTO_ID (que segue identificando UMA sessão abre-fecha, ou
                       //    um evento de abertura de lote). Só relevante em ABERTURA/FECHAMENTO —
                       //    vazio em parada/retrabalho (não tocam Saldo_Parcial). Sempre derivado
                       //    no servidor, nunca lido do payload do cliente.
};

const COL_AB = {
  OPERADOR:        0,  // código do operador
  IMPLEMENTO:      1,  // nrSerie / implemento
  TIPO:            2,  // tipo de apontamento
  OPERACAO:        3,  // operação
  CARIMBO:         4,  // carimbo da abertura
  COD_ITEM:        5,  // código do item
  QTD_PLANEJADA:   6,  // quantidade planejada
  NR_SERIE:        7,  // nrSerie
  IMPLEMENTO_NOME: 8,  // nome do implemento
  CLIENTE:         9,  // cliente
  OPERADOR_NOME:   10, // nome do operador
  LOTE_SERIES:     11, // JSON de lote de séries
  ABERTO_ID:       12, // abertoId (AP-XXXXXXXXXX)
  IS_LOTE:         13, // 'Sim'/'Não' — identifica explicitamente apontamento em lote
  ALERTA_ENVIADO_EM: 14, // carimbo de quando o alerta de "aberto há muito tempo" foi enviado (vazio = nunca)
  CICLO_ID:        15, // cicloId (série única) — para lote, o cicloId de cada série vive dentro
                       // do próprio JSON de LOTE_SERIES (campo cicloId por item), não aqui.
};

const TIPOS_APONTAMENTO = {
  'ABERTURA':           'ABERTURA',
  'FECHAMENTO':         'FECHAMENTO',
  'INICIO_RETRABALHO':  'INÍCIO DE RETRABALHO',
  'TERMINO_RETRABALHO': 'TÉRMINO DE RETRABALHO',
  'INICIO_PARADA':      'INÍCIO DE PARADA',
  'TERMINO_PARADA':     'TÉRMINO DE PARADA',
};

const OPERACOES = {
  '0010': '0010 - CORTAR',
  '0020': '0020 - FURAR',
  '0030': '0030 - MONTAR CALDEIRARIA',
  '0040': '0040 - SOLDAR',
  '0050': '0050 - LIXAR',
  '0060': '0060 - PINTAR',
  '0070': '0070 - MONTAR MECÂNICA | ELÉTRICA',
  '0080': '0080 - INSPECIONAR',
  '0090': '0090 - CALAFETAR',
  '0100': '0100 - ADESIVAR',
  '0101': '0101 - TESTES',
  '0102': '0102 - TREINAMENTO',
};

// ================================================================
// ENTRY POINTS
// ================================================================

// ================================================================
// AUTORIZAÇÃO DE ADMINISTRAÇÃO
// A chave que libera as ações de manutenção/destrutivas é lida do PropertiesService
// (fora do código-fonte). Se ainda não configurada, cai no valor histórico 'AGF2026'
// para não quebrar URLs e triggers existentes durante a transição.
// Para rotacionar a chave (recomendado): no editor GAS execute uma vez —
//   PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', 'SUA_NOVA_CHAVE');
// e atualize as URLs/gatilhos que usam key=... . Depois disso, o valor 'AGF2026' deixa
// de funcionar automaticamente (o fallback só vale enquanto a propriedade não existe).
// ================================================================
function _adminKey_() {
  try {
    const k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
    if (k) return k;
  } catch (e) { /* PropertiesService indisponível — usa fallback histórico */ }
  return 'AGF2026';
}
function _adminAutorizado(keyRecebida) {
  return String(keyRecebida == null ? '' : keyRecebida) === _adminKey_();
}
function configurarAdminKey(novaChave) {
  // Utilitário one-shot: define a chave de admin no PropertiesService.
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', String(novaChave || '').trim());
  return 'ADMIN_KEY configurada.';
}

function doGet(e) {
  const action = e.parameter.action || '';

  if (action === 'verificarAberto')  return verificarAberto(e.parameter.operador, e.parameter.implemento);
  if (action === 'verificarSaldo')    return verificarSaldoParcialAction(e.parameter.nrSerie, e.parameter.codItem || '', e.parameter.operacao);
  if (action === 'verificarSaldoLotes') return verificarSaldoLotesAction(e.parameter.operador);
  if (action === 'verificarFechamentoRegistrado') return verificarFechamentoRegistradoAction(e.parameter.abertoId, e.parameter.tipo);
  if (action === 'notificarFalhaPermanente') return notificarFalhaPermanenteAction(e.parameter.item);
  if (action === 'getJustificativasAuditoria') return getJustificativasAuditoriaAction();
  if (action === 'removerJustificativaAuditoria') return removerJustificativaAuditoriaAction(e.parameter.chave, e.parameter.key);
  if (action === 'desfazerFechamento') return desfazerFechamentoAction(e.parameter.abertoId, e.parameter.key);
  if (action === 'getCadastros')     return getCadastros();
  if (action === 'getAbertos')       return getAbertosAction();
  if (action === 'getData')          return getDadosRespostas();
  if (action === 'getAnaliseIA')     return getAnaliseIAAction();
  if (action === 'triggerRelatorio' && _adminAutorizado(e.parameter.key)) {
    try {
      enviarRelatorioSemanal();
      return jsonResponse({ success: true, message: 'Relatório semanal enviado para ' + EMAIL_RELATORIO });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'triggerDiario' && _adminAutorizado(e.parameter.key)) {
    try {
      enviarRelatorioDiario();
      return jsonResponse({ success: true, message: 'Relatório diário enviado para ' + EMAIL_RELATORIO });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'ativarTrigger' && _adminAutorizado(e.parameter.key)) {
    try {
      criarTriggerRelatorioSemanal();
      return jsonResponse({ success: true, message: 'Trigger semanal criado com sucesso.' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'ativarTriggerDiario' && _adminAutorizado(e.parameter.key)) {
    try {
      criarTriggerRelatorioDiario();
      return jsonResponse({ success: true, message: 'Trigger diário criado (seg–sex 07h).' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'ativarTodosTriggers' && _adminAutorizado(e.parameter.key)) {
    try {
      criarTriggerRelatorioSemanal();
      criarTriggerRelatorioDiario();
      return jsonResponse({ success: true, message: 'Triggers semanal e diário criados com sucesso.' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'reconstruirAbertos' && _adminAutorizado(e.parameter.key)) {
    try {
      const result = reconstruirAbertos();
      return jsonResponse({ success: true, ...result });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'ativarTriggerReconciliacao' && _adminAutorizado(e.parameter.key)) {
    try {
      criarTriggerReconciliacaoAbertos();
      return jsonResponse({ success: true, message: 'Trigger de reconciliação criado: reconstruirAbertos a cada 30 minutos.' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'normalizarOperadores' && _adminAutorizado(e.parameter.key)) {
    try {
      const total = normalizarCodigosOperador();
      return jsonResponse({ success: true, message: total + ' código(s) normalizado(s) com sucesso.' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'normalizarRespostas' && _adminAutorizado(e.parameter.key)) {
    try {
      const total = normalizarRespostasColB();
      return jsonResponse({ success: true, message: total + ' registro(s) da aba Respostas normalizado(s).' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'normalizarDatas' && _adminAutorizado(e.parameter.key)) {
    try {
      const total = normalizarDatasColA();
      return jsonResponse({ success: true, message: total + ' data(s) normalizada(s) na coluna A.' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'normalizarTodos' && _adminAutorizado(e.parameter.key)) {
    try {
      const result = normalizarTodosDados();
      return jsonResponse({ success: true, message: result.datas + ' data(s) + ' + result.operadores + ' operador(es) normalizados. Total: ' + result.total, detail: result });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'limparTestes' && _adminAutorizado(e.parameter.key)) {
    try {
      const total = limparRegistrosTeste();
      return jsonResponse({ success: true, message: total + ' linha(s) de teste removida(s).' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'limparStressTest' && _adminAutorizado(e.parameter.key)) {
    try {
      const dryRun = e.parameter.dryRun !== 'false';
      return jsonResponse(limparDadosStressTest(dryRun));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'removerSemTimestamp' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(removerRegistrosSemTimestamp());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'reverterTimestamps' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(reverterTimestampsInterpolados());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'preencherTimestamps' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(preencherTimestampsVazios());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'listarRevisoes' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(listarRevisoesPlanilha());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'recuperarTimestamps' && _adminAutorizado(e.parameter.key)) {
    try {
      const revId = e.parameter.revId || '';
      if (!revId) return jsonResponse({ success: false, message: 'Parâmetro revId obrigatório.' });
      return jsonResponse(recuperarTimestampsDaRevisao(revId));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'aplicarTimestamps' && _adminAutorizado(e.parameter.key)) {
    try {
      const revId = e.parameter.revId || '';
      if (!revId) return jsonResponse({ success: false, message: 'Parâmetro revId obrigatório.' });
      return jsonResponse(aplicarTimestampsDaRevisao(revId));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'removerRegistroPorId' && _adminAutorizado(e.parameter.key)) {
    try {
      const idAlvo = e.parameter.id || '';
      if (!idAlvo) return jsonResponse({ success: false, message: 'Parâmetro id obrigatório.' });
      const resultado = removerRegistroPorAbertoId(idAlvo);
      return jsonResponse({ success: true, ...resultado });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'removerPorCarimboECodItem' && _adminAutorizado(e.parameter.key)) {
    try {
      const carimbo = e.parameter.carimbo || '';
      const codItem = e.parameter.codItem || '';
      if (!carimbo || !codItem) return jsonResponse({ success: false, message: 'Parâmetros carimbo e codItem obrigatórios.' });
      const resultado = removerRegistroPorCarimboECodItem(carimbo, codItem);
      return jsonResponse({ success: true, ...resultado });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'diagRespostas' && _adminAutorizado(e.parameter.key)) {
    try {
      const ss2 = SpreadsheetApp.openById(SPREADSHEET_ID);
      const aba2 = ss2.getSheetByName(ABA_RESPOSTAS);
      const lastRow = aba2.getLastRow();
      const maxRows = aba2.getMaxRows();
      const dados2 = aba2.getRange(Math.max(1, lastRow - 4), 1, 5, 16).getValues();
      const rows = dados2.map((r, i) => ({
        sheetRow: lastRow - 4 + i,
        colA: String(r[0] || '').substring(0, 30),
        colB: String(r[1] || '').substring(0, 30),
        colC: String(r[2] || ''),
        colH: String(r[7] || ''),
        colP: String(r[15] || '')
      }));
      return jsonResponse({ lastRow, maxRows, lastRows: rows });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'analyzeOrphans' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(analisarOrfaos());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'analisarInconsistencias' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(analisarInconsistencias());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'impactoOrfaos' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(impactoOrfaos());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'marcarLegado' && _adminAutorizado(e.parameter.key)) {
    try {
      const cutoff = e.parameter.cutoff || '';
      const result = marcarOrfaosLegado(cutoff);
      return jsonResponse(result);
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'previewAberturasOrfas' && _adminAutorizado(e.parameter.key)) {
    try {
      const cutoff = e.parameter.cutoff || '2026-05-29';
      return jsonResponse(previewAberturasOrfas(cutoff));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'deletarAberturasOrfas' && _adminAutorizado(e.parameter.key)) {
    try {
      const cutoff = e.parameter.cutoff || '2026-05-29';
      return jsonResponse(deletarAberturasOrfas(cutoff));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'previewArquivamento' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(previewArquivamento(e.parameter.margemDias));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'executarArquivamento' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(executarArquivamento(e.parameter.margemDias));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'ativarTriggerArquivamento' && _adminAutorizado(e.parameter.key)) {
    try {
      criarTriggerArquivamento();
      return jsonResponse({ success: true, message: 'Trigger de arquivamento criado: executarArquivamento diariamente às 3h.' });
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'previewBackfillIdsParadaRetrabalho' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(previewBackfillIdsParadaRetrabalho());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'executarBackfillIdsParadaRetrabalho' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(executarBackfillIdsParadaRetrabalho());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }

  // Ações via payload GET (contorna CORS)
  if (e.parameter.payload) {
    try {
      const payload = JSON.parse(e.parameter.payload);
      if (payload.action === 'salvarOperador')   return salvarOperador(payload);
      if (payload.action === 'removerOperador')  return removerOperador(payload);
      if (payload.action === 'salvarSerie')      return salvarSerie(payload);
      if (payload.action === 'removerSerie')     return removerSerie(payload);
      if (payload.action === 'salvarOperacao')   return salvarOperacao(payload);
      if (payload.action === 'removerOperacao')  return removerOperacao(payload);
      // Localizar linhas por identificadores (func+ts) para deleção
      if (payload.action === 'localizarLinhas' && _adminAutorizado(payload.key)) {
        return jsonResponse(localizarLinhasPorIdentificadores(payload.identifiers || [], payload.deletar === true));
      }
      // Deletar linhas por número (mais preciso que func+ts)
      if (payload.action === 'deletarPorLinhas' && _adminAutorizado(payload.key)) {
        return jsonResponse(deletarLinhasPorNumero(payload.rows || [], payload.dryRun === true, payload.tiposPermitidos || null));
      }
      // Endpoint dedicado: deletar FECHAMENTOs sem ABERTURA (aceita apenas tipo FECHAMENTO)
      if (payload.action === 'deletarFechamentosOrfaos' && _adminAutorizado(payload.key)) {
        return jsonResponse(deletarLinhasPorNumero(payload.rows || [], payload.dryRun === true, ['FECHAMENTO']));
      }
      if (payload.action === 'editarApontamento') {
        return editarApontamento(payload);
      }
      if (payload.action === 'salvarJustificativaAuditoria') {
        return salvarJustificativaAuditoriaAction(payload);
      }
      return gravarApontamento(payload);
    } catch (err) {
      return jsonResponse({ success: false, message: 'Erro ao processar payload: ' + err.message });
    }
  }

  if (action === 'smokeTest' && _adminAutorizado(e.parameter.key)) {
    try {
      return jsonResponse(smokeTest());
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }
  if (action === 'forceMatchOrfaos' && _adminAutorizado(e.parameter.key)) {
    try {
      const dryRun  = e.parameter.dryRun !== 'false';   // default: true (seguro)
      const cutoff  = e.parameter.cutoff || '2026-06-08';
      return jsonResponse(forceMatchOrfaos(dryRun, cutoff));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }

  if (action === 'excluirFechamentosOrfaos' && _adminAutorizado(e.parameter.key)) {
    try {
      const dryRun = e.parameter.dryRun !== 'false';
      return jsonResponse(excluirFechamentosOrfaos(dryRun));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }

  if (action === 'excluirAberturasOrfas' && _adminAutorizado(e.parameter.key)) {
    try {
      const dryRun = e.parameter.dryRun !== 'false';
      return jsonResponse(excluirAberturasOrfas(dryRun));
    } catch(err) {
      return jsonResponse({ success: false, message: err.message });
    }
  }

  return jsonResponse({ status: 'ok', message: 'AGRICEF Web App v4 ativo' });
}

function doPost(e) {
  try {
    let payload;
    if (e.parameter && e.parameter.payload) {
      payload = JSON.parse(e.parameter.payload);
    } else {
      payload = JSON.parse(e.postData.contents);
    }
    if (payload.action === 'salvarOperador')   return salvarOperador(payload);
    if (payload.action === 'removerOperador')  return removerOperador(payload);
    if (payload.action === 'salvarSerie')      return salvarSerie(payload);
    if (payload.action === 'removerSerie')     return removerSerie(payload);
    if (payload.action === 'salvarOperacao')   return salvarOperacao(payload);
    if (payload.action === 'removerOperacao')  return removerOperacao(payload);
    if (payload.action === 'localizarLinhas' && _adminAutorizado(payload.key)) {
      return jsonResponse(localizarLinhasPorIdentificadores(payload.identifiers || [], payload.deletar === true));
    }
    if (payload.action === 'deletarPorLinhas' && _adminAutorizado(payload.key)) {
      return jsonResponse(deletarLinhasPorNumero(payload.rows || [], payload.dryRun === true, payload.tiposPermitidos || null));
    }
    if (payload.action === 'deletarFechamentosOrfaos' && _adminAutorizado(payload.key)) {
      return jsonResponse(deletarLinhasPorNumero(payload.rows || [], payload.dryRun === true, ['FECHAMENTO']));
    }
    // Fix#ID-LINK: endpoint de migração histórica — escreve abertoId em linhas específicas
    if (payload.action === 'migrarIds' && _adminAutorizado(payload.key)) {
      return jsonResponse(migrarIdsHistoricos(payload.updates || []));
    }
    return gravarApontamento(payload);
  } catch (err) {
    return jsonResponse({ success: false, message: 'Erro: ' + err.message });
  }
}

// ================================================================
// VERIFICAR APONTAMENTO ABERTO — retorna dados completos para
// o app pré-preencher o fechamento
// ================================================================

function verificarAberto(operador, implemento) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);

    // Fix#ParadaAninhada: se o operador tem uma parada aninhada ativa, ela é o que precisa
    // ser fechado AGORA (a ABERTURA/RETRABALHO pai está congelada, aguardando). Checa isso
    // ANTES de Abertos — senão o operador veria a produção/retrabalho como "aberto" e
    // tentaria fechá-la diretamente, o que o bloqueio em gravarApontamento rejeitaria mesmo
    // assim, mas de forma confusa (sem explicar que precisa fechar a parada primeiro).
    const abaParadasAnVerif = garantirAbaParadasAninhadas(ss);
    const dadosParadasAnVerif = abaParadasAnVerif.getDataRange().getValues();
    for (let i = 1; i < dadosParadasAnVerif.length; i++) {
      const rowPa = dadosParadasAnVerif[i];
      if (!rowPa[0] || !mesmoOperador(rowPa[0], operador)) continue;
      return jsonResponse({
        aberto:        true,
        tipo:          'INÍCIO DE PARADA',
        operacao:      String(rowPa[5] || ''), // TipoParada
        carimbo:       formatarCarimboGs(rowPa[6]),
        codItem:       String(rowPa[8] || ''), // CodItemPai (contexto)
        qtdPlanejada:  '',
        nrSerie:       String(rowPa[7] || ''), // NrSeriePai (contexto)
        implemento:    '',
        cliente:       '',
        operadorNome:  String(rowPa[1] || ''),
        loteSeries:    null,
        abertoId:      String(rowPa[4] || '').trim(), // AbertoIdParada — usado no TERMINO_PARADA
        paradaAninhada: true,
        abertoIdPai:   String(rowPa[2] || '').trim(),
      });
    }

    const aba   = garantirAbaAbertos(ss);
    const dados = aba.getDataRange().getValues();

    // Colunas aba Abertos:
    // 0:Operador 1:Implemento(nrSerie) 2:Tipo 3:Operação 4:Carimbo
    // 5:CodItem  6:QtdPlanejada 7:NrSerie 8:ImplementoNome 9:Cliente 10:OperadorNome
    // 11:LoteSeries(JSON) 12:AbertoId

    for (let i = 1; i < dados.length; i++) {
      const row = dados[i];
      if (!row[0]) continue;
      if (!mesmoOperador(row[0], operador)) continue;

      const abertoIdAbertos = String(row[12] || '').trim();

      // ── Cross-validação read-only: garante que o abertoId de Abertos existe em Respostas ──
      // Lê apenas a coluna P (índice 16) — operação leve, sem efeitos colaterais.
      // Se não encontrar, trata como fantasma e busca em Respostas diretamente.
      if (abertoIdAbertos) {
        const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
        let idValidoEmRe = false;
        if (abaRe) {
          const ultimaLinhaRe = abaRe.getLastRow();
          if (ultimaLinhaRe > 1) {
            const colP = abaRe.getRange(2, 16, ultimaLinhaRe - 1, 1).getValues();
            idValidoEmRe = colP.some(r => String(r[0] || '').trim() === abertoIdAbertos);
          }
        }
        if (!idValidoEmRe) {
          // Abertos tem um abertoId que não existe em Respostas → fantasma.
          // Busca a abertura real diretamente em Respostas (fallback completo).
          // A limpeza do fantasma será feita por reconstruirAbertos (próximo ciclo de 30 min)
          // ou por gravarApontamento na próxima escrita.
          // Bug#fix2: Respostas col B armazena operadorNome (nome), não código — passar ambos
          const operadorNomeFallback = String(row[10] || '').trim();
          const abertaReal = buscarAberturaAbertaEmRespostas_(ss, operador, operadorNomeFallback);
          if (abertaReal) {
            // Tenta recuperar loteSeries do Abertos (o fantasma ainda tem o JSON correto em row[11])
            let loteFallback = abertaReal.loteSeries || null;
            if (!loteFallback && row[11]) {
              try { loteFallback = JSON.parse(String(row[11])); } catch(e) {}
            }
            return jsonResponse({ aberto: true, ...abertaReal, loteSeries: loteFallback });
          }
          return jsonResponse({ aberto: false });
        }
      }

      // ── Registro válido em Abertos ──
      let loteSeries = null;
      if (row[11]) {
        try { loteSeries = JSON.parse(String(row[11])); } catch(e) {}
      }
      return jsonResponse({
        aberto:        true,
        tipo:          String(row[2]  || ''),
        operacao:      String(row[3]  || ''),  // Bug#24: Sheets pode retornar number em células numéricas
        carimbo:       formatarCarimboGs(row[4]),
        codItem:       String(row[5]  || ''),
        qtdPlanejada:  row[6]  || '',          // mantém número — frontend usa aritmética
        nrSerie:       String(row[7]  || ''),  // Bug#24b: nrSerie numérica (ex: 22000084)
        implemento:    String(row[8]  || ''),
        cliente:       String(row[9]  || ''),
        operadorNome:  String(row[10] || ''),
        loteSeries:    loteSeries,
        abertoId:      abertoIdAbertos,
      });
    }

    // ── Fallback: operador não encontrado em Abertos — busca diretamente em Respostas ──
    // Isso resolve casos onde reconstruirAbertos ainda não rodou após uma ABERTURA recente,
    // ou quando Abertos ficou desincronizado por qualquer motivo.
    const abertaEmRe = buscarAberturaAbertaEmRespostas_(ss, operador);
    if (abertaEmRe) {
      // abertaEmRe.loteSeries já vem populado se Respostas col Q tiver o JSON (novo comportamento)
      return jsonResponse({ aberto: true, ...abertaEmRe });
    }

    return jsonResponse({ aberto: false });
  } catch (err) {
    return jsonResponse({ aberto: false, erro: String(err && err.message || err), stack: String(err && err.stack || '') });
  }
}

// ================================================================
// HELPER: busca a última ABERTURA sem FECHAMENTO em Respostas para um operador
// ================================================================

/**
 * Varre Respostas do início ao fim e retorna os dados da última ABERTURA
 * que NÃO possui um FECHAMENTO subsequente para o mesmo operador.
 *
 * Retorna null se o operador não tiver nenhuma abertura em aberto em Respostas.
 *
 * Lógica: para cada linha de Respostas do operador:
 *   - ABERTURA → registra como "aberta"
 *   - FECHAMENTO → anula a abertura anterior (delete)
 * No final, o que sobrou é a abertura genuinamente em aberto.
 *
 * Custo: leitura sequencial de Respostas (~1-2s para 4000+ linhas).
 * Só é chamado em fallback (Abertos inconsistente ou fantasma), não em fluxo normal.
 */
// Reconstrói o array loteSeries a partir de linhas irmãs em Respostas que compartilham o mesmo
// abertoId. Usado como fallback para registros legados que não têm col Q preenchida (gravados
// antes da versão que adicionou a coluna). dadosRe deve ser o array já lido pelo caller.
function reconstruirLoteSeriesDeRespostas_(dadosRe, abertoId) {
  if (!dadosRe || !abertoId) return null;
  const resultado = [];
  const _tiposAbSet = new Set([TIPOS_APONTAMENTO.ABERTURA, TIPOS_APONTAMENTO.INICIO_RETRABALHO, TIPOS_APONTAMENTO.INICIO_PARADA].map(v => v.normalize('NFC')));
  for (let i = 1; i < dadosRe.length; i++) {
    const row = dadosRe[i];
    if (String(row[15] || '').trim() !== abertoId) continue;
    if (!_tiposAbSet.has(String(row[2] || '').normalize('NFC'))) continue;
    const campoF  = String(row[5] || '');
    const partes  = campoF.split(' | ');
    const nrSerie = (partes[0] || '').trim();
    const impl    = (partes[1] || '').trim();
    const cli     = (partes[2] || '').trim();
    if (!nrSerie) continue;
    resultado.push({
      nrSerie:      nrSerie,
      implemento:   impl,
      cliente:      cli,
      qtdPlanejada: Number(row[14]) || 0,
    });
  }
  return resultado.length > 0 ? resultado : null;
}

function buscarAberturaAbertaEmRespostas_(ss, operador, operadorNome) {
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  if (!abaRe) return null;
  const dadosRe = abaRe.getDataRange().getValues();

  // Bug#fix: ehAbertura/ehFechamento são closures de outra função — definir localmente
  const _tiposAbSet = new Set([TIPOS_APONTAMENTO.ABERTURA, TIPOS_APONTAMENTO.INICIO_RETRABALHO, TIPOS_APONTAMENTO.INICIO_PARADA].map(function(v){return v.normalize('NFC');}));
  const _tiposFeSet = new Set([TIPOS_APONTAMENTO.FECHAMENTO, TIPOS_APONTAMENTO.TERMINO_RETRABALHO, TIPOS_APONTAMENTO.TERMINO_PARADA].map(function(v){return v.normalize('NFC');}));
  const _ehAb = function(t) { return _tiposAbSet.has(String(t || '').normalize('NFC')); };
  const _ehFe = function(t) { return _tiposFeSet.has(String(t || '').normalize('NFC')); };

  let aberta = null;
  // Para lotes com fechamento parcial: mesmo bug que reconstruirAbertos — um FECHAMENTO de
  // uma série cancelava toda a abertura do operador. Corrigido com contagem por abertoId.
  const _seriesAbertasPorId  = {}; // abertoId → count de linhas ABERTURA
  const _seriesFechadasPorId = {}; // abertoId → count de linhas FECHAMENTO

  for (let i = 1; i < dadosRe.length; i++) {
    const row    = dadosRe[i];
    const opRow  = String(row[1] || '').trim();
    // Bug#fix2: Respostas col B armazena operadorNome (nome completo), não código.
    // Comparar contra ambos: código (operador) e nome (operadorNome).
    const matchOp = mesmoOperador(opRow, operador) || (operadorNome && mesmoOperador(opRow, operadorNome));
    if (!opRow || !matchOp) continue;

    const tipo = String(row[2] || '').trim();
    const abertoIdLinha = String(row[15] || '').trim();

    if (_ehAb(tipo)) {
      // Desmembra campo F: "nrSerie | implementoNome | cliente"
      const campoF     = String(row[5] || '');
      const partes     = campoF.split(' | ');
      const nrSerie    = (partes[0] || '').trim();
      const implemento = (partes[1] || '').trim();
      const cliente    = (partes[2] || '').trim();

      // Col Q (índice 16): loteSeries JSON gravado na ABERTURA de lote — para reconstrução.
      // Fallback para registros legados (sem col Q): reconstrói agrupando linhas irmãs pelo abertoId.
      let loteSeriesFromRe = null;
      const loteSeriesRaw = String(row[16] || '').trim();
      if (loteSeriesRaw) {
        try { loteSeriesFromRe = JSON.parse(loteSeriesRaw); } catch(e) {}
      }
      if (!loteSeriesFromRe && abertoIdLinha && (nrSerie === '' || implemento === 'LOTE')) {
        // Legado: implemento='LOTE' indica lote sem col Q — reconstrói das linhas irmãs
        loteSeriesFromRe = reconstruirLoteSeriesDeRespostas_(dadosRe, abertoIdLinha);
      }

      if (abertoIdLinha) _seriesAbertasPorId[abertoIdLinha] = (_seriesAbertasPorId[abertoIdLinha] || 0) + 1;

      aberta = {
        tipo:          tipo,
        operacao:      String(row[3]  || '').trim(),
        carimbo:       formatarCarimboGs(row[0]),
        codItem:       String(row[4]  || '').trim(),
        qtdPlanejada:  row[14] || '',    // coluna O
        nrSerie:       nrSerie,
        implemento:    implemento,
        cliente:       cliente,
        operadorNome:  opRow,
        abertoId:      abertoIdLinha,    // coluna P
        loteSeries:    loteSeriesFromRe, // coluna Q (ou reconstruído de irmãs; null se não é lote)
      };

    } else if (_ehFe(tipo)) {
      // Conta série fechada por abertoId
      if (abertoIdLinha) _seriesFechadasPorId[abertoIdLinha] = (_seriesFechadasPorId[abertoIdLinha] || 0) + 1;
      // Só cancela aberta quando TODAS as séries do lote foram fechadas
      const totalAbertas  = _seriesAbertasPorId[abertoIdLinha] || 1;
      const totalFechadas = _seriesFechadasPorId[abertoIdLinha] || 0;
      if (totalFechadas >= totalAbertas) {
        aberta = null;
      }
    }
  }

  // Para lotes parcialmente fechados: filtrar loteSeries para mostrar apenas séries restantes
  if (aberta && aberta.loteSeries && Array.isArray(aberta.loteSeries) && aberta.abertoId) {
    const _fechadasSet = new Set();
    for (let i = 1; i < dadosRe.length; i++) {
      const row = dadosRe[i];
      if (String(row[15] || '').trim() !== aberta.abertoId) continue;
      const tipo = String(row[2] || '').trim();
      if (!_ehFe(tipo)) continue;
      const nrSerieFech = String(row[5] || '').split(' | ')[0].trim();
      if (nrSerieFech) _fechadasSet.add(nrSerieFech);
    }
    if (_fechadasSet.size > 0) {
      aberta.loteSeries = aberta.loteSeries.filter(s =>
        !_fechadasSet.has(String(s.nrSerie || '').trim())
      );
    }
  }

  return aberta; // null se não há abertura em aberto
}

// ================================================================
// HELPERS DE PERFORMANCE / IDEMPOTÊNCIA
// ================================================================

// Retorna Set de nrSerie válidas com cache de 5 min — elimina releitura
// repetida do Cadastro_Series em cada request (única ou lote).
function getSeriesValidas_(ss) {
  try {
    const cache  = CacheService.getScriptCache();
    const cached = cache.get('series_validas_v1');
    if (cached) return new Set(JSON.parse(cached));
    const aba = ss.getSheetByName(ABA_SERIES);
    if (!aba) return new Set();
    const series = aba.getDataRange().getValues().slice(1)
      .filter(r => String(r[3]).toUpperCase() !== 'NÃO' && r[0] !== '')
      .map(r => String(r[0]).trim());
    try { cache.put('series_validas_v1', JSON.stringify(series), 300); } catch(e) {}
    return new Set(series);
  } catch(e) { return new Set(); }
}

// Garante que a aba IdempotencyLog existe com cabeçalho.
function garantirAbaIdempotencyLog(ss) {
  let aba = ss.getSheetByName(ABA_IDEMPOTENCY);
  if (!aba) {
    aba = ss.insertSheet(ABA_IDEMPOTENCY);
    aba.appendRow(['requestId', 'responseJson', 'timestamp']);
    aba.setFrozenRows(1);
  }
  return aba;
}

// Trigger diário: remove entradas mais antigas que 24 h do IdempotencyLog.
function limparIdempotencyLog() {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_IDEMPOTENCY);
    if (!aba) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const dados  = aba.getDataRange().getValues();
    for (let i = dados.length - 1; i >= 1; i--) {
      const ts = new Date(dados[i][2]).getTime();
      if (!isNaN(ts) && ts < cutoff) aba.deleteRow(i + 1);
    }
  } catch(e) {}
}

// ================================================================
// GRAVAR APONTAMENTO
// ================================================================

function gravarApontamento(payload) {
  // Idempotência: verifica requestId ANTES do lock — evita contenção desnecessária em retries.
  // O cliente inclui um requestId único por operação lógica; o GAS armazena a resposta em
  // CacheService (TTL 6h). Retries com o mesmo requestId recebem o resultado cacheado sem
  // re-executar, tornando safe qualquer retry de escrita sem risco de duplicata.
  const reqId = String(payload.requestId || '').trim().replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64);
  if (reqId) {
    try {
      const cached = CacheService.getScriptCache().get('req_' + reqId);
      if (cached) return jsonResponse(JSON.parse(cached));
    } catch(e) { /* CacheService indisponível — prossegue normalmente sem idempotência */ }
  }

  // Opção A (perf): o lock global antigo segurava a validação inteira (leituras de Abertos/
  // Respostas/Paradas_Aninhadas, checagens de duplicidade/fantasma/B7.4) — a maior parte do
  // tempo de gravação (14-70s medidos em produção) não era escrita, era essa validação
  // esperando na fila atrás de outros operadores. Agora: um soft-lock por operador (logo
  // abaixo da sanitização) protege contra o mesmo operador enviando 2 requisições sobrepostas
  // (double-tap, ou retry da fila offline colidindo com envio manual) — o único caso real de
  // corrida aqui, já que abertoId/lote são amarrados ao operador dono. O LockService global de
  // verdade fica estreitado só em volta da escrita (ver mais abaixo, perto de "linhasGravadas"),
  // preservando exatamente a mesma proteção que reconstruirAbertos/editarApontamento/etc. já
  // esperam dele — só que por uma janela muito mais curta.
  // opKey declarado AQUI FORA (não dentro do try abaixo) — precisa continuar acessível no
  // finally externo, que libera o lock por operador. Um `const` declarado dentro de um bloco
  // try{} não é visível no finally{} correspondente (blocos diferentes) — declarar só dentro
  // teria feito o release no finally lançar ReferenceError, engolido pelo catch(e){} local,
  // deixando o lock preso pelo TTL inteiro (bug real, pego em teste ao vivo antes de publicar).
  let opKey = null;
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
    if (!abaRe) return jsonResponse({ success: false, message: 'Aba "' + ABA_RESPOSTAS + '" não encontrada.' });

    // Fallback persistente de idempotência: CacheService foi frio (GAS restart ou TTL expirou).
    // Lê só a col A do IdempotencyLog — rápido, aba pequena (máx. 24h de dados).
    if (reqId) {
      try {
        const abaLog = ss.getSheetByName(ABA_IDEMPOTENCY);
        if (abaLog && abaLog.getLastRow() > 1) {
          const ids = abaLog.getRange(2, 1, abaLog.getLastRow() - 1, 1).getValues();
          const idx = ids.findIndex(r => String(r[0]).trim() === reqId);
          if (idx >= 0) {
            const respStr = String(abaLog.getRange(idx + 2, 2).getValue());
            try {
              const parsed = JSON.parse(respStr);
              // Restaura CacheService para os próximos retries desta sessão
              try { CacheService.getScriptCache().put('req_' + reqId, respStr, 21600); } catch(e) {}
              return jsonResponse(parsed);
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    const abaAb = garantirAbaAbertos(ss);

    // _dadosRe: leitura única da aba Respostas dentro do lock — reaproveitada em:
    //   • verificação de fantasma (linha de abertura sem par em Respostas)
    //   • B7.4 anti-duplo-fechamento
    // Evita duas chamadas getDataRange() na mesma execução.
    let _dadosRe = null;
    const getDadosRe = () => {
      if (!_dadosRe) _dadosRe = abaRe.getDataRange().getValues();
      return _dadosRe;
    };

    // ---------------------------------------------------------------
    // SANITIZAÇÃO DE ENTRADA — normaliza campos ANTES de qualquer
    // validação: trim de espaços, uppercase em tipoApontamento,
    // normalização de nrSerie em cada item do lote.
    // Protege contra erros humanos de digitação comuns.
    // ---------------------------------------------------------------
    const _san = v => String(v == null ? '' : v).trim();
    payload.tipoApontamento = _san(payload.tipoApontamento).toUpperCase();
    payload.operador        = _san(payload.operador);
    payload.nrSerie         = _san(payload.nrSerie);
    payload.codItem         = _san(payload.codItem);
    payload.operacao        = _san(payload.operacao);
    payload.abertoId        = _san(payload.abertoId);
    if (Array.isArray(payload.loteSeries)) {
      payload.loteSeries = payload.loteSeries.map(function(item) {
        return Object.assign({}, item, { nrSerie: _san(item.nrSerie) });
      });
    }

    // ---------------------------------------------------------------
    // LOCK POR OPERADOR (Opção A) — evita que o MESMO operador tenha duas requisições
    // sobrepostas passando juntas pela validação (double-tap, ou fila offline retentando
    // enquanto um envio manual já está em curso). Operadores DIFERENTES nunca disputam essa
    // chave, então não esperam um pelo outro. CacheService não tem check-and-set atômico —
    // por isso o get+put roda dentro de um lock global de verdade, mas só por milissegundos
    // (não durante a validação inteira), fechando essa janela de corrida.
    // ---------------------------------------------------------------
    opKey = 'oplock_' + normalizarCodigoOp(payload.operador || '');
    let gotOpLock = false;
    {
      const briefLock = LockService.getScriptLock();
      try {
        briefLock.waitLock(3000);
        if (!CacheService.getScriptCache().get(opKey)) {
          CacheService.getScriptCache().put(opKey, '1', 90); // TTL de segurança
          gotOpLock = true;
        }
      } catch (briefLockErr) {
        return jsonResponse({ success: false, transiente: true, message: 'Servidor ocupado. Tente novamente em instantes.' });
      } finally {
        briefLock.releaseLock();
      }
    }
    if (!gotOpLock) {
      return jsonResponse({ success: false, transiente: true, message: 'Aguarde a operação anterior deste operador terminar.' });
    }

    const tipo = payload.tipoApontamento;

    // ---------------------------------------------------------------
    // VALIDAÇÃO DE CAMPOS OBRIGATÓRIOS (Bug#16, Bug#17, Bug#18)
    // ---------------------------------------------------------------
    if (!tipo) {
      return jsonResponse({ success: false, message: 'Campo tipoApontamento é obrigatório.' });
    }
    if (!TIPOS_APONTAMENTO[tipo]) {
      return jsonResponse({ success: false, message: 'Tipo de apontamento inválido: "' + tipo + '". Use: ' + Object.keys(TIPOS_APONTAMENTO).join(', ') });
    }
    if (!payload.operador || String(payload.operador).trim() === '') {
      return jsonResponse({ success: false, message: 'Campo operador é obrigatório.' });
    }

    // ---------------------------------------------------------------
    // VALIDAÇÕES DE CAMPOS ESPECÍFICOS POR TIPO (Bug#21, #22, #23)
    // ---------------------------------------------------------------
    const _tiposAb = ['ABERTURA', 'INICIO_RETRABALHO', 'INICIO_PARADA'];

    // Lote: a série fica em loteSeries (várias), não no campo nrSerie — não exigir nrSerie nesse caso
    const _ehLote = payload.isLote === true || (payload.loteSeries && Array.isArray(payload.loteSeries) && payload.loteSeries.length > 0);

    // Bug#22 fix: nrSerie obrigatório para tipos de abertura (exceto lote, validado mais abaixo)
    // Fix#ParadaSemSerie: INICIO_PARADA nunca exige nrSerie — uma parada é um evento de tempo,
    // não amarrado a uma série específica. Isso ficou explícito ao tentar aninhar parada dentro
    // de um LOTE aberto (várias séries em loteSeries, nenhuma em payload.nrSerie): a checagem
    // rodava ANTES de qualquer detecção de aninhamento e travava com "nrSerie obrigatório" mesmo
    // sendo aninhada. Padrão já usado na prática antes disso: operadores registravam parada
    // solta usando um valor qualquer em nrSerie (ex: "ENGENHARIA") só pra passar por aqui.
    if (_tiposAb.includes(tipo) && tipo !== 'INICIO_PARADA' && !_ehLote && (!payload.nrSerie || String(payload.nrSerie).trim() === '')) {
      return jsonResponse({ success: false, message: 'Campo nrSerie é obrigatório para ' + tipo + '.' });
    }
    // Bug#28 fix: nrSerie não pode conter "|" (separador do campo F da planilha)
    if (payload.nrSerie && String(payload.nrSerie).includes('|')) {
      return jsonResponse({ success: false, message: 'Campo nrSerie não pode conter o caractere "|" (usado como separador interno).' });
    }

    // Bug#23 fix: motivo obrigatório para INICIO_RETRABALHO e INICIO_PARADA
    if (tipo === 'INICIO_RETRABALHO' && (!payload.retrabalho || String(payload.retrabalho).trim() === '')) {
      return jsonResponse({ success: false, message: 'Campo retrabalho (motivo do retrabalho) é obrigatório para INICIO_RETRABALHO.' });
    }
    if (tipo === 'INICIO_PARADA' && (!payload.parada || String(payload.parada).trim() === '')) {
      return jsonResponse({ success: false, message: 'Campo parada (tipo de parada) é obrigatório para INICIO_PARADA.' });
    }

    // Bug#21 fix: LOTE requer ao menos uma série em loteSeries
    if (payload.isLote === true || (payload.loteSeries && Array.isArray(payload.loteSeries))) {
      if (!payload.loteSeries || !Array.isArray(payload.loteSeries) || payload.loteSeries.length === 0) {
        return jsonResponse({ success: false, message: 'Apontamento em lote requer pelo menos uma série em loteSeries.' });
      }
    }

    // Detectar nrSerie duplicada em loteSeries — erro humano comum ao montar o lote
    if (_ehLote && Array.isArray(payload.loteSeries)) {
      const _seenSeries = new Set();
      const _dupSeries  = [];
      for (var _di = 0; _di < payload.loteSeries.length; _di++) {
        const _ds = payload.loteSeries[_di].nrSerie; // já trimada pela sanitização acima
        if (!_ds) continue;
        if (_seenSeries.has(_ds)) { _dupSeries.push(_ds); } else { _seenSeries.add(_ds); }
      }
      if (_dupSeries.length > 0) {
        return jsonResponse({ success: false, message: 'Série(s) duplicada(s) em loteSeries: ' + _dupSeries.join(', ') + '. Cada série deve aparecer apenas uma vez.', seriesDuplicadas: _dupSeries });
      }
    }

    // Validar nrSerie única contra cadastro (lotes já validam as séries de loteSeries abaixo)
    if (_tiposAb.includes(tipo) && !_ehLote && payload.nrSerie) {
      const seriesValidasSingle = getSeriesValidas_(ss);
      const nrSerieSingle = String(payload.nrSerie).trim();
      if (nrSerieSingle && seriesValidasSingle.size > 0 && !seriesValidasSingle.has(nrSerieSingle)) {
        return jsonResponse({
          success: false,
          message: 'Série não encontrada no cadastro: ' + nrSerieSingle,
          seriesInvalidas: [nrSerieSingle],
        });
      }
    }

    // Validar qtdPlanejada para tipos de abertura: deve ser número não-negativo
    if (_tiposAb.includes(tipo)) {
      const _qtdPlRaw = payload.qtdPlanejada;
      if (_qtdPlRaw !== undefined && _qtdPlRaw !== null && _qtdPlRaw !== '') {
        const _qtdPlNum = Number(_qtdPlRaw);
        if (isNaN(_qtdPlNum) || !isFinite(_qtdPlNum)) {
          return jsonResponse({ success: false, message: 'Campo qtdPlanejada inválido: "' + _qtdPlRaw + '". Deve ser um número.', qtdPlanejadaInvalida: true });
        }
        if (_qtdPlNum < 0) {
          return jsonResponse({ success: false, message: 'Campo qtdPlanejada não pode ser negativo. Recebido: ' + _qtdPlNum, qtdPlanejadaInvalida: true });
        }
      }
    }

    // Lê Abertos UMA VEZ — reaproveitado em validação, loteSeriesFechamento e atualizarAbertos
    const dadosAbertos = abaAb.getDataRange().getValues();

    // Fechamento parcial de lote: guarda o array original de séries (com qtdPlanejada já fixada
    // na abertura) do registro que está sendo fechado. Preenchido na validação abaixo e
    // reaproveitado tanto na gravação por série quanto no saldo parcial.
    let loteSeriesFechamento = null;
    // Mapa nrSerie → {qtdPlanejada, qtdRealizada} efetivamente gravados nesta chamada (preenchido
    // junto com a gravação das linhas de FECHAMENTO de lote). Usado no saldo parcial para não
    // aplicar os totais do payload (que somam todas as séries) em cada série individualmente —
    // bug pré-existente: sem isso, o saldo de cada série era calculado com qtdPl/qtdRe do LOTE
    // INTEIRO, não da série específica.
    let loteQtdPorSerieMap = null;
    // Opção A (perf): abertoId de uma linha fantasma detectada na validação (fora do lock
    // estreitado). A EXECUÇÃO do delete fica adiada pro trecho de escrita (dentro do lock),
    // relocalizada por abertoId contra uma releitura fresca de Abertos — nunca deletar por
    // índice fora do lock, já que reconstruirAbertos (ou outro request) pode ter reordenado
    // as linhas nesse meio-tempo.
    let abertoIdFantasma = null;

    // ---------------------------------------------------------------
    // VALIDAÇÃO SERVER-SIDE — executada ANTES de qualquer escrita,
    // dentro do lock, para bloquear dupla abertura com segurança.
    // ---------------------------------------------------------------
    const tiposAbertura = ['ABERTURA', 'INICIO_RETRABALHO', 'INICIO_PARADA'];

    // Mapeamento: tipo de fechamento → tipo de abertura esperado na aba Abertos
    const TIPO_COMPATIVEL = {
      'FECHAMENTO':         'ABERTURA',
      'TERMINO_RETRABALHO': 'INÍCIO DE RETRABALHO',
      'TERMINO_PARADA':     'INÍCIO DE PARADA',
    };
    const tiposFechamento = Object.keys(TIPO_COMPATIVEL);

    // Fix#ParadaAninhada: INICIO_PARADA pode aninhar dentro de uma ABERTURA ou INÍCIO DE
    // RETRABALHO já aberto, SEM fechá-lo — pausa a atividade-pai em vez de conflitar com ela
    // (retrabalho continua sem aninhamento — só produção e retrabalho podem SER pausados,
    // a parada em si nunca pausa outra parada). Roda ANTES do bloqueio genérico abaixo porque,
    // para este tipo específico, achar uma linha do operador em Abertos não é necessariamente
    // um erro: se o tipo existente for aninhável, desvia para Paradas_Aninhadas em vez de
    // bloquear. paradaAninhadaInfo != null sinaliza esse desvio para o bloco de gravação mais
    // abaixo (grava em Paradas_Aninhadas, não em Abertos).
    let paradaAninhadaInfo = null;
    if (tipo === 'INICIO_PARADA') {
      const abaParadasAn = garantirAbaParadasAninhadas(ss);
      const dadosParadasAn = abaParadasAn.getDataRange().getValues();
      for (let i = 1; i < dadosParadasAn.length; i++) {
        if (mesmoOperador(dadosParadasAn[i][0], payload.operador)) {
          return jsonResponse({
            success: false,
            bloqueado: true,
            message: 'Operador já possui uma parada em andamento. Finalize-a antes de iniciar outra.',
          });
        }
      }
      for (let i = 1; i < dadosAbertos.length; i++) {
        if (!dadosAbertos[i][0]) continue;
        if (mesmoOperador(dadosAbertos[i][0], payload.operador)) {
          const tipoExistenteAn = String(dadosAbertos[i][2] || '').trim();
          if (tipoExistenteAn === 'ABERTURA' || tipoExistenteAn === TIPOS_APONTAMENTO.INICIO_RETRABALHO) {
            paradaAninhadaInfo = {
              abertoIdPai: String(dadosAbertos[i][12] || '').trim(),
              tipoPai:     tipoExistenteAn,
              nrSeriePai:  String(dadosAbertos[i][7]  || '').trim(),
              codItemPai:  String(dadosAbertos[i][5]  || '').trim(),
            };
          }
          break; // achou a linha do operador (aninhável ou não) — não há mais o que procurar
        }
      }
    }

    if (tiposAbertura.includes(tipo) && !paradaAninhadaInfo) {
      for (let i = 1; i < dadosAbertos.length; i++) {
        if (!dadosAbertos[i][0]) continue; // linha vazia
        if (mesmoOperador(dadosAbertos[i][0], payload.operador)) {
          const abertoIdExistente = String(dadosAbertos[i][12] || '');
          const tipoExistente     = String(dadosAbertos[i][2]  || '');
          const serieExistente    = String(dadosAbertos[i][7]  || '');

          // Bug#29 fix (movido de verificarAberto para gravarApontamento):
          // Cross-valida registro em Abertos contra Respostas ANTES de bloquear.
          // Se o abertoId não existe em Respostas (col P), o registro é fantasma —
          // remove-o e deixa a abertura continuar.
          if (abertoIdExistente) {
            // Reaprovita getDadosRe() — evita segunda leitura completa da aba Respostas
            {
              const dadosRePhantom = getDadosRe();
              const existeEmRe = dadosRePhantom.some(
                (r, idx) => idx > 0 && String(r[15] || '').trim() === abertoIdExistente
              );
              if (!existeEmRe) {
                // Fantasma confirmado — NÃO deleta agora (validação roda fora do lock
                // estreitado; deletar por índice aqui poderia acertar a linha errada se
                // reconstruirAbertos reordenar Abertos antes da escrita). Só registra o
                // abertoId — o delete de verdade acontece dentro do lock, relocalizado.
                abertoIdFantasma = abertoIdExistente;
                // Sincroniza o array EM MEMÓRIA (só afeta as decisões desta validação —
                // dadosAbertos não é mais usado para escrita por índice, ver dadosAbertosFresh).
                dadosAbertos.splice(i, 1);
                Logger.log('gravarApontamento [Bug#29]: fantasma detectado (delete adiado) — op=' +
                  payload.operador + ', abertoId=' + abertoIdExistente);
                break; // sai do loop e continua para gravar a nova abertura
              }
            }
          }

          // Bug#6 fix (revisado): idempotência para phantom record recovery.
          // Antes retornava success:true — isso causava aceitação silenciosa de duplas aberturas (E4b/E5b/E6b/E7b).
          // Agora sempre retorna success:false.
          // O abertoId ainda é incluído para que o frontend possa recuperar um phantom sem double-gravar.
          const mesmoTipo  = tipoExistente === (TIPOS_APONTAMENTO[tipo] || tipo);
          const mesmaSerie = serieExistente === String(payload.nrSerie || '').trim();
          // Lote: inclui loteSeries na resposta de bloqueio para que o frontend monte o grid de
          // fechamento parcial mesmo quando o bloqueio vem do fluxo de ABERTURA (não de verificarAberto).
          let loteSeriesExistente = null;
          if (dadosAbertos[i][11]) {
            try { loteSeriesExistente = JSON.parse(String(dadosAbertos[i][11])); } catch(e) {}
          }
          if (mesmoTipo && mesmaSerie && abertoIdExistente) {
            return jsonResponse({
              success: false,
              bloqueado: true,
              jaAberto: true,
              abertoId: abertoIdExistente,
              message: 'Apontamento em aberto — feche antes de abrir novo.',
              aberto: {
                tipo:         tipoExistente,
                operacao:     dadosAbertos[i][3] || '',
                carimbo:      formatarCarimboGs(dadosAbertos[i][4]),
                codItem:      dadosAbertos[i][5] || '',
                qtdPlanejada: dadosAbertos[i][6] || '',
                nrSerie:      serieExistente,
                implemento:   dadosAbertos[i][8] || '',
                cliente:      dadosAbertos[i][9] || '',
                loteSeries:   loteSeriesExistente,
              },
            });
          }
          // Bloqueado por abertura de tipo/série diferente — inclui abertoId para o frontend recuperar
          return jsonResponse({
            success: false,
            bloqueado: true,
            message: 'Operador já possui apontamento em aberto. Feche-o antes de iniciar um novo.',
            abertoId: abertoIdExistente, // frontend usa para identificar o apontamento existente
            aberto: {
              tipo:         tipoExistente,
              operacao:     dadosAbertos[i][3] || '',
              carimbo:      formatarCarimboGs(dadosAbertos[i][4]),
              codItem:      dadosAbertos[i][5] || '',
              qtdPlanejada: dadosAbertos[i][6] || '',
              nrSerie:      serieExistente,
              implemento:   dadosAbertos[i][8] || '',
              cliente:      dadosAbertos[i][9] || '',
              loteSeries:   loteSeriesExistente,
            }
          });
        }
      }
    }

    // ---------------------------------------------------------------
    // VALIDAÇÃO DE COMPATIBILIDADE DE TIPO — garante que o fechamento
    // corresponde exatamente ao tipo de abertura em aberto.
    // Ex.: TERMINO_PARADA só pode fechar INÍCIO DE PARADA.
    //
    // Também valida:
    //   • semAberto: bloqueia fechamento quando não há abertura em aberto
    //   • serieIncompativel: bloqueia FECHAMENTO com nrSerie diferente da abertura
    // ---------------------------------------------------------------
    // Fix#ParadaAninhada: TERMINO_PARADA pode estar fechando uma parada ANINHADA — ela nunca
    // esteve em Abertos (só em Paradas_Aninhadas), então o bloco de validação de fechamento
    // genérico abaixo (que exige achar algo em Abertos) devolveria "semAberto" incorretamente.
    // Detecta isso ANTES e desvia por completo — não passa pela validação genérica.
    let paradaAninhadaParaFechar = null;
    if (tipo === 'TERMINO_PARADA') {
      const abaParadasAnFech = garantirAbaParadasAninhadas(ss);
      const dadosParadasAnFech = abaParadasAnFech.getDataRange().getValues();
      for (let i = 1; i < dadosParadasAnFech.length; i++) {
        if (mesmoOperador(dadosParadasAnFech[i][0], payload.operador)) {
          paradaAninhadaParaFechar = {
            linhaPlanilha: i + 1,
            abertoIdPai:    String(dadosParadasAnFech[i][2] || '').trim(),
            abertoIdParada: String(dadosParadasAnFech[i][4] || '').trim(),
          };
          break;
        }
      }
    }

    if (tiposFechamento.includes(tipo) && !paradaAninhadaParaFechar) {
      const abertoIdPayload = String(payload.abertoId || '').trim();

      // Validar formato do abertoId quando fornecido: deve ser AP-XXXXXXXXXX (10 hex)
      if (abertoIdPayload && !/^AP-[0-9A-Fa-f]{10}$/i.test(abertoIdPayload)) {
        return jsonResponse({ success: false, message: 'Formato de abertoId inválido: "' + abertoIdPayload + '". Formato esperado: AP- seguido de 10 caracteres hexadecimais.', abertoIdInvalido: true });
      }

      // B7.4: anti-duplo-fechamento — verifica se já existe linha de fechamento com este abertoId
      // em Respostas. Protege contra: retry após falha de rede onde o frontend não recebeu
      // a confirmação mas o backend já gravou. Só faz a checagem se abertoId foi informado.
      //
      // Para LOTE com múltiplos fechamentos parciais, o mesmo abertoId terá várias linhas de
      // FECHAMENTO (uma por lote parcial). Nesse caso, verifica por SÉRIE: só bloqueia se todas
      // as séries do payload já estão fechadas neste abertoId. Para série única, bloqueia se
      // qualquer linha de fechamento com esse abertoId já existe.
      if (abertoIdPayload) {
        const tipoFechFormatado = TIPOS_APONTAMENTO[tipo] || tipo;
        const dadosReCheck = getDadosRe(); // reutiliza leitura já feita (lazy, uma só vez por request)
        const ehLoteFechamento = Array.isArray(payload.loteSeries) && payload.loteSeries.length > 0;

        let jaFechado = false;
        if (ehLoteFechamento) {
          // Lote: bloqueia só se TODAS as séries do payload já constam como fechadas neste abertoId
          const seriesJaFechadas = new Set();
          for (let i = 1; i < dadosReCheck.length; i++) {
            const r = dadosReCheck[i];
            if (String(r[COL_RE.ABERTO_ID] || '').trim() !== abertoIdPayload) continue;
            if (String(r[COL_RE.TIPO] || '').trim() !== tipoFechFormatado) continue;
            // Extrai nrSerie do campo F (formato: "nrSerie | implemento | cliente")
            const campoF = String(r[COL_RE.SERIE] || '').split(' | ')[0].trim();
            if (campoF) seriesJaFechadas.add(campoF);
          }
          jaFechado = payload.loteSeries.every(item =>
            seriesJaFechadas.has(String(item.nrSerie || '').trim())
          );
        } else {
          // Série única: bloqueia se qualquer fechamento com esse abertoId já existe
          jaFechado = dadosReCheck.some((r, idx) =>
            idx > 0 &&
            String(r[COL_RE.ABERTO_ID] || '').trim() === abertoIdPayload &&
            String(r[COL_RE.TIPO]      || '').trim() === tipoFechFormatado
          );
        }

        if (jaFechado) {
          Logger.log('B7.4: fechamento duplo bloqueado — abertoId=' + abertoIdPayload + ' tipo=' + tipo);
          return jsonResponse({ success: false, message: 'Este apontamento já foi fechado. Nenhuma ação necessária.', jaFechado: true });
        }
      }

      let encontrou = false;
      for (let i = 1; i < dadosAbertos.length; i++) {
        if (!dadosAbertos[i][0]) continue;
        const rowId   = String(dadosAbertos[i][12] || '').trim();
        const matchId = abertoIdPayload && rowId && rowId === abertoIdPayload;
        // matchOp: quando abertoId é fornecido, só aceita linha que NÃO tem abertoId próprio
        // (entrada legada sem ID). Se a linha tem abertoId diferente → ignora, evita fechar
        // o apontamento errado silenciosamente quando o usuário passa um abertoId inválido.
        const matchOp = !matchId && mesmoOperador(dadosAbertos[i][0], payload.operador) &&
                        (!abertoIdPayload || !rowId);
        if (matchId || matchOp) {
          // Bug#5 fix: abertoId só pode ser usado pelo próprio operador que o criou
          if (matchId && !mesmoOperador(dadosAbertos[i][0], payload.operador)) {
            return jsonResponse({
              success: false,
              message: 'Não é possível fechar um apontamento de outro operador.',
              semAberto: true,
            });
          }
          // Fix#ParadaAninhada: não permite fechar a ABERTURA/INÍCIO DE RETRABALHO enquanto
          // a parada aninhada dela ainda está ativa — força o operador a encerrar a parada
          // primeiro. Sem isso, fechar "por baixo" da parada deixaria a linha em
          // Paradas_Aninhadas órfã (apontando para um pai que já não existe mais em Abertos).
          if (tipo === 'FECHAMENTO' || tipo === 'TERMINO_RETRABALHO') {
            const rowIdAtual = String(dadosAbertos[i][12] || '').trim();
            const abaParadasAnCheck = garantirAbaParadasAninhadas(ss);
            const dadosParadasAnCheck = abaParadasAnCheck.getDataRange().getValues();
            const paradaAtivaNesta = dadosParadasAnCheck.some((r, idx) =>
              idx > 0 && String(r[2] || '').trim() === rowIdAtual
            );
            if (paradaAtivaNesta) {
              return jsonResponse({
                success: false,
                message: 'Existe uma parada em andamento vinculada a este apontamento — finalize a parada antes de fechar.',
                paradaAninhadaAtiva: true,
              });
            }
          }
          encontrou = true;
          const tipoAberto   = String(dadosAbertos[i][2] || '').trim();
          const tipoEsperado = TIPO_COMPATIVEL[tipo];
          if (tipoEsperado && tipoAberto !== tipoEsperado) {
            return jsonResponse({
              success: false,
              message: 'Tipo de fechamento incompatível. Você possui "' + tipoAberto +
                       '" em aberto, mas tentou registrar "' + (TIPOS_APONTAMENTO[tipo] || tipo) + '".',
              incompativel: true,
              tipoAberto: tipoAberto,
            });
          }
          // Valida série apenas para FECHAMENTO (TERMINO_PARADA/RETRABALHO não têm série)
          if (tipo === 'FECHAMENTO') {
            // Fechamento precisa corresponder à MESMA atividade que foi aberta — não só à
            // mesma série. Sem isso, é possível "fechar" uma abertura usando operação/item
            // diferentes (caso real encontrado: operador abriu "TESTES" e, horas depois,
            // fechou como "MONTAR MECÂNICA/HIDRÁULICA" na mesma série — provavelmente o app
            // não reconheceu a abertura pendente e caiu no formulário manual, onde esses
            // campos ficam livres). Isso corrompe o histórico silenciosamente.
            const opAbertoLabel = String(dadosAbertos[i][COL_AB.OPERACAO] || '').trim();
            const opAbertoCod   = opAbertoLabel.substring(0, 4);
            const opFechamentoCod = String(payload.operacao || '').substring(0, 4);
            if (opFechamentoCod && opAbertoCod && opFechamentoCod !== opAbertoCod) {
              return jsonResponse({
                success: false,
                message: 'Operação incompatível. A abertura foi feita para "' + opAbertoLabel +
                         '" mas o fechamento informou operação "' + opFechamentoCod + '".',
                incompativel: true,
                tipoAberto: tipoAberto,
              });
            }
            const itemAberto      = String(dadosAbertos[i][COL_AB.COD_ITEM] || '').trim();
            const itemFechamento  = String(payload.codItem || '').trim();
            if (itemFechamento && itemAberto && itemFechamento !== itemAberto) {
              return jsonResponse({
                success: false,
                message: 'Código do item incompatível. A abertura foi feita para "' + itemAberto +
                         '" mas o fechamento informou "' + itemFechamento + '".',
                incompativel: true,
                tipoAberto: tipoAberto,
              });
            }
            const serieAberto      = String(dadosAbertos[i][7]  || '').trim();
            const loteAbertoRaw    = String(dadosAbertos[i][11] || '').trim();
            const serieFechamento  = String(payload.nrSerie || '').trim();
            const loteFechamento   = payload.loteSeries && Array.isArray(payload.loteSeries) && payload.loteSeries.length > 0;

            if (loteAbertoRaw) {
              // Abertura foi em lote — fechamento precisa informar quais séries está fechando
              // agora (permite fechamento parcial: algumas séries podem continuar abertas).
              let seriesOriginais = [];
              try { seriesOriginais = JSON.parse(loteAbertoRaw); } catch(e) {}
              if (!loteFechamento) {
                return jsonResponse({
                  success: false,
                  message: 'Este apontamento foi aberto em lote — selecione quais séries está fechando.',
                  loteFechamentoObrigatorio: true,
                  seriesDisponiveis: seriesOriginais,
                });
              }
              // Bug fix: toda série do fechamento precisa pertencer ao lote original —
              // sem isso, seria possível "fechar" séries que nunca foram abertas.
              const nrSeriesOriginais  = new Set(seriesOriginais.map(s => String(s.nrSerie).trim()));
              const nrSeriesFechamento = payload.loteSeries.map(s => String(s.nrSerie).trim());
              const seriesForaDoLote = nrSeriesFechamento.filter(s => !nrSeriesOriginais.has(s));
              if (seriesForaDoLote.length > 0) {
                return jsonResponse({
                  success: false,
                  message: 'Série(s) não pertencem ao lote aberto: ' + seriesForaDoLote.join(', '),
                  serieIncompativel: true,
                });
              }
              loteSeriesFechamento = seriesOriginais; // reaproveitado na gravação por série e no saldo parcial
            } else if (loteFechamento) {
              // Defensivo: payload trouxe loteSeries mas a abertura NÃO foi feita em lote
              return jsonResponse({
                success: false,
                message: 'Este apontamento não foi aberto em lote — não é possível fechar com seleção de séries.',
                serieIncompativel: true,
              });
            } else if (serieAberto) {
              // Comportamento original: série única — precisa bater com a abertura
              if (serieFechamento && serieFechamento !== serieAberto) {
                return jsonResponse({
                  success: false,
                  message: 'Série incompatível. A abertura foi feita para "' + serieAberto +
                           '" mas o fechamento informou "' + serieFechamento + '".',
                  serieIncompativel: true,
                  serieAberto: serieAberto,
                });
              }
            }
          }
          break; // encontrou o registro — compatível → pode continuar
        }
      }
      // Bloqueia fechamento sem nenhuma abertura em aberto para o operador
      if (!encontrou) {
        return jsonResponse({
          success: false,
          message: 'Nenhum apontamento em aberto encontrado para este operador. Registre uma abertura antes de fechar.',
          semAberto: true,
        });
      }
    }

    // Carimbo: vem do browser já formatado (dd/MM/yyyy HH:mm:ss no fuso local)
    // Fallback para o servidor em GMT-3 caso não venha ou seja inválido
    // Bug#19 fix: validar formato dd/MM/yyyy HH:mm:ss e rejeitar datas absurdas
    let carimbo = Utilities.formatDate(new Date(), 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
    if (payload.timestamp && typeof payload.timestamp === 'string' && !payload.timestamp.includes('T')) {
      const tsMatch = payload.timestamp.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
      if (tsMatch) {
        const ano = parseInt(tsMatch[3]);
        const anoAtual = new Date().getFullYear();
        if (ano >= 2020 && ano <= anoAtual + 1) {
          carimbo = payload.timestamp; // aceita apenas anos razoáveis
        }
        // Caso contrário usa server time (timestamp futuro/passado distante ignorado)
      }
    }

    // ID único para o registro na aba Abertos (gerado uma vez por abertura)
    // Fix#ID-LINK: Fechamentos gravam o abertoId da Abertura que estão fechando (não um ID aleatório)
    // Isso cria o elo direto ABERTURA↔FECHAMENTO na planilha para pareamento sem algoritmo
    const abertoId = tiposAbertura.includes(tipo) ? gerarIdApontamento() : null;

    const nomeOperador  = payload.operadorNome || payload.operador || '';
    const tipoFormatado = TIPOS_APONTAMENTO[tipo] || tipo;
    const op1           = OPERACOES[payload.operacao]     || payload.operacao     || '';
    const op2           = OPERACOES[payload.opRetrabalho] || payload.opRetrabalho || '';
    const codItem       = payload.codItem || '';

    const qtd = (payload.quantidade === null || payload.quantidade === undefined || payload.quantidade === '')
      ? '' : Number(payload.quantidade);

    // Bug#26 fix: quantidade não-numérica (ex: "abc" → NaN passa typeof number)
    if (typeof qtd === 'number' && isNaN(qtd)) {
      return jsonResponse({ success: false, message: 'Quantidade inválida: valor não numérico. Recebido: "' + payload.quantidade + '"' });
    }
    // Bug#20 fix: quantidade realizada não pode ser negativa
    if (typeof qtd === 'number' && qtd < 0) {
      return jsonResponse({ success: false, message: 'Quantidade realizada não pode ser negativa. Valor recebido: ' + qtd });
    }
    // Bug#12 fix: limite máximo de quantidade (evita valores absurdos como 999999)
    const QTD_MAX = 99999;
    if (typeof qtd === 'number' && qtd > QTD_MAX) {
      return jsonResponse({ success: false, message: 'Quantidade realizada acima do limite máximo permitido (' + QTD_MAX + '). Valor recebido: ' + qtd });
    }
    const qtdPlNum = Number(payload.qtdPlanejada || 0);
    if (qtdPlNum > QTD_MAX) {
      return jsonResponse({ success: false, message: 'Quantidade planejada acima do limite máximo permitido (' + QTD_MAX + '). Valor recebido: ' + qtdPlNum });
    }

    let campoF = '';
    if (payload.nrSerie && payload.implemento && payload.cliente) {
      campoF = payload.nrSerie + ' | ' + payload.implemento + ' | ' + payload.cliente;
    } else {
      campoF = payload.implemento || '';
    }

    let tipoParada = payload.parada || '';
    if (tipoParada === 'Set-up') tipoParada = 'SET - UP';

    // Coluna O: quantidade planejada (só na abertura)
    const qtdPlanejada = payload.qtdPlanejada ? String(payload.qtdPlanejada) : '';

    const linha = [
      carimbo,                       // A
      nomeOperador,                  // B
      tipoFormatado,                 // C
      op1,                           // D
      codItem,                       // E
      campoF,                        // F
      qtd,                           // G — quantidade realizada
      payload.obs1       || '',      // H
      payload.retrabalho || '',      // I
      payload.numRNC     || '',      // J
      tipoParada,                    // K
      op2,                           // L
      payload.setup      || '',      // M
      payload.obs2       || '',      // N
      qtdPlanejada,                  // O — quantidade planejada
      // Fix#ID-LINK: col P = "elo de pareamento"
      // • ABERTURA  → abertoId (novo ID gerado acima)
      // • FECHAMENTO → payload.abertoId (ID da ABERTURA sendo fechada, validado antes)
      // • TERMINO_PARADA de parada aninhada → abertoId da PRÓPRIA parada, achado no servidor
      //   (Paradas_Aninhadas) — não depende do client mandar o valor certo.
      // • Parada/Retrabalho (demais casos) → ID próprio (não participa do pareamento AB↔FE)
      tiposAbertura.includes(tipo)
        ? abertoId
        : paradaAninhadaParaFechar
          ? paradaAninhadaParaFechar.abertoIdParada
          : (tiposFechamento.includes(tipo) && String(payload.abertoId || '').trim())
            ? String(payload.abertoId).trim()
            : gerarIdApontamento(), // P
      '', // Q — LoteSeries (só setado explicitamente no path de lote, linhaMod[16] abaixo)
      // Fix#ParadaAninhada: R — AbertoId do pai (ABERTURA/INÍCIO DE RETRABALHO) pausado por
      // esta parada. Preenchido tanto na abertura quanto no fechamento da parada aninhada,
      // para o dashboard conseguir cruzar todo o par INICIO/TERMINO pelo mesmo pai. Vazio em
      // qualquer linha que não seja uma parada aninhada.
      paradaAninhadaInfo ? paradaAninhadaInfo.abertoIdPai
        : paradaAninhadaParaFechar ? paradaAninhadaParaFechar.abertoIdPai
        : '',
    ];

    let linhasGravadas = 1; // padrão série única; sobrescrito nos paths de lote abaixo
    // respOk/respStr declarados aqui fora (não dentro do try do lock estreitado abaixo) —
    // precisam continuar acessíveis depois que esse try fechar, para a persistência durável
    // de idempotência e o jsonResponse final.
    let respOk = null, respStr = null;

    // ---------------------------------------------------------------
    // LOCK GLOBAL (Opção A, estreitado) — a partir daqui até o fim do bloco de saldo parcial
    // é a ÚNICA parte que precisa de exclusão mútua de verdade entre TODOS os operadores (e
    // contra reconstruirAbertos/editarApontamento/etc, que seguram o mesmo LockService.getScriptLock()).
    // Tudo antes disso (validação, checagens de duplicidade/fantasma) já rodou protegido só
    // pelo lock por operador acima — suficiente porque recursos são amarrados ao operador dono.
    // ---------------------------------------------------------------
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
    } catch (lockErr) {
      return jsonResponse({ success: false, transiente: true, message: 'Servidor ocupado. Tente novamente em instantes.' });
    }
    try {

    // Releitura fresca de Abertos — dadosAbertos (lido na validação, fora do lock) pode estar
    // desatualizado se reconstruirAbertos (ou outra operação global) rodou nesse meio-tempo, e
    // ela reordena as linhas ao reconstruir. Qualquer escrita POR ÍNDICE (atualizarAbertos, o
    // delete de fantasma adiado) usa dadosAbertosFresh — nunca o snapshot antigo da validação.
    const dadosAbertosFresh = abaAb.getDataRange().getValues();

    // Executa agora o delete de fantasma detectado (e adiado) na validação, relocalizado por
    // abertoId contra a leitura fresca — pode já não estar mais lá (reconstruirAbertos já
    // pode ter limpado), tudo bem, ignora nesse caso.
    if (abertoIdFantasma) {
      for (let _iFant = 1; _iFant < dadosAbertosFresh.length; _iFant++) {
        if (String(dadosAbertosFresh[_iFant][12] || '').trim() === abertoIdFantasma) {
          abaAb.deleteRow(_iFant + 1);
          dadosAbertosFresh.splice(_iFant, 1);
          break;
        }
      }
    }

    if (payload.loteSeries && Array.isArray(payload.loteSeries) && payload.loteSeries.length > 0) {
      // Bug#25 fix: todos os itens do lote devem ter nrSerie
      const semNrSerie = payload.loteSeries.filter(item => !item.nrSerie || String(item.nrSerie).trim() === '');
      if (semNrSerie.length > 0) {
        return jsonResponse({ success: false, message: semNrSerie.length + ' item(s) do lote sem nrSerie. Todos os itens precisam informar nrSerie.' });
      }
      // Bug#27 fix: não permite séries duplicadas no mesmo lote
      const nrSeriesNoLote = payload.loteSeries.map(item => String(item.nrSerie).trim());
      const nrSeriesUnicas = new Set(nrSeriesNoLote);
      if (nrSeriesUnicas.size !== nrSeriesNoLote.length) {
        const duplicatas = nrSeriesNoLote.filter((s, i) => nrSeriesNoLote.indexOf(s) !== i);
        return jsonResponse({ success: false, message: 'Séries duplicadas no lote: ' + [...new Set(duplicatas)].join(', '), duplicatas: [...new Set(duplicatas)] });
      }
      // Bug#11 fix: validar séries do LOTE contra cadastro (usa cache — sem releitura do sheet)
      {
        const seriesValidas = getSeriesValidas_(ss);
        const seriesInvalidas = seriesValidas.size > 0
          ? payload.loteSeries
              .filter(item => item.nrSerie && !seriesValidas.has(String(item.nrSerie).trim()))
              .map(item => item.nrSerie)
          : []; // Set vazio = falha no cache — skip silencioso para não bloquear
        if (seriesInvalidas.length > 0) {
          return jsonResponse({
            success: false,
            message: 'Séries não encontradas no cadastro: ' + seriesInvalidas.join(', '),
            seriesInvalidas: seriesInvalidas,
          });
        }
      }

      // Bug#4 fix (revisado): distribuição proporcional sem sobra — soma exata ao total,
      // em vez de Math.ceil em cada série (que inflava o total quando não dividia exato).
      const numSeries = payload.loteSeries.length;
      const qtdReTotal  = (qtd === '' ? 0 : Number(qtd));
      const distribuirQtd = (total, n) => {
        if (n <= 0) return [];
        const base  = Math.floor(total / n);
        const resto = total - base * n;
        return Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0));
      };
      // Quantidade realizada por série:
      // • Se o payload já vem com qtdRealizada explícita em CADA item de loteSeries (novo
      //   fluxo: operador informa quanto produziu de cada série individualmente, inclusive
      //   0 para as que não avançaram), usa esses valores diretamente — sem dividir nada.
      // • Senão (chamadas antigas, ou ABERTURA onde esse campo não existe), mantém o
      //   comportamento legado de dividir o total igualmente entre as séries.
      const temQtdRealizadaPorSerie = !tiposAbertura.includes(tipo) &&
        payload.loteSeries.every(item => item.qtdRealizada !== undefined && item.qtdRealizada !== null && item.qtdRealizada !== '');
      let qtdRePorSerieArr;
      if (temQtdRealizadaPorSerie) {
        const QTD_MAX_LOTE = 99999;
        for (const item of payload.loteSeries) {
          const v = Number(item.qtdRealizada);
          if (isNaN(v)) return jsonResponse({ success: false, message: 'Quantidade inválida na série ' + item.nrSerie + ': "' + item.qtdRealizada + '"' });
          if (v < 0) return jsonResponse({ success: false, message: 'Quantidade realizada não pode ser negativa (série ' + item.nrSerie + ')' });
          if (v > QTD_MAX_LOTE) return jsonResponse({ success: false, message: 'Quantidade realizada acima do limite máximo permitido (série ' + item.nrSerie + ')' });
        }
        qtdRePorSerieArr = payload.loteSeries.map(item => Number(item.qtdRealizada));
      } else {
        qtdRePorSerieArr = distribuirQtd(qtdReTotal, numSeries);
      }

      // Quantidade planejada por série:
      // • ABERTURA — divide o total do lote agora e FIXA esse valor por série (persistido
      //   em payload.loteSeries, que atualizarAbertos grava na aba Abertos). A partir daqui
      //   esse valor não muda mais, mesmo que o lote seja fechado em partes depois.
      // • FECHAMENTO — nunca recalcula a partir de payload.qtdPlanejada: usa o valor que já
      //   foi fixado na abertura (loteSeriesFechamento), olhando pela série. Sem isso, um
      //   fechamento parcial distorceria o planejado das séries que ainda ficam abertas.
      let qtdPlPorSerieArr;
      if (tiposAbertura.includes(tipo)) {
        // Reabertura de lote com saldo pendente: cada série já vem com sua própria
        // qtdPlanejada (o saldo restante dela, que pode ser diferente entre séries do mesmo
        // lote — ex: uma ficou com 1 e outra com 2). Sem isso, dividiríamos o total igualmente
        // e perderíamos a quantidade individual correta de cada série.
        const temQtdPlanejadaPorSerie = payload.loteSeries.every(item => item.qtdPlanejada !== undefined && item.qtdPlanejada !== null && item.qtdPlanejada !== '');
        if (temQtdPlanejadaPorSerie) {
          qtdPlPorSerieArr = payload.loteSeries.map(item => Number(item.qtdPlanejada) || 0);
        } else {
          const qtdPlTotal = Number(payload.qtdPlanejada || 0);
          qtdPlPorSerieArr = distribuirQtd(qtdPlTotal, numSeries);
        }
        payload.loteSeries = payload.loteSeries.map((item, idx) => ({ ...item, qtdPlanejada: qtdPlPorSerieArr[idx] }));
      } else {
        qtdPlPorSerieArr = payload.loteSeries.map(item => {
          const original = (loteSeriesFechamento || []).find(s => String(s.nrSerie).trim() === String(item.nrSerie).trim());
          return original && original.qtdPlanejada != null ? Number(original.qtdPlanejada) : 0;
        });
        // Guarda o valor efetivo por série para o saldo parcial usar abaixo, em vez dos totais do payload.
        loteQtdPorSerieMap = {};
        payload.loteSeries.forEach((item, idx) => {
          loteQtdPorSerieMap[String(item.nrSerie).trim()] = {
            qtdPlanejada: qtdPlPorSerieArr[idx],
            qtdRealizada: qtdRePorSerieArr[idx],
          };
        });
      }

      // Batch write — uma única chamada de API para todas as séries do lote
      // Nota: linha[15] (abertoId/elo de pareamento) já vem correto do cálculo acima
      // (abertoId novo para ABERTURA, payload.abertoId para FECHAMENTO) — não sobrescrever aqui,
      // pois isso apagava o elo em fechamentos de lote (bug: toda linha P ficava vazia).
      // Para ABERTURA de lote: grava o loteSeries completo na col Q (índice 16) de cada linha.
      // Permite que reconstruirAbertos e buscarAberturaAbertaEmRespostas_ recuperem a lista de
      // séries mesmo após o Abertos ser reconstruído (que antes zeravam loteSeries para '').
      const loteSeriesParaRespostas = tiposAbertura.includes(tipo) ? JSON.stringify(payload.loteSeries) : '';
      const rows = payload.loteSeries.map((item, idx) => {
        const linhaMod = [...linha];
        linhaMod[5]  = item.nrSerie + ' | ' + item.implemento + ' | ' + item.cliente;
        linhaMod[6]  = qtdRePorSerieArr[idx];          // G — qtd realizada por série
        linhaMod[14] = String(qtdPlPorSerieArr[idx]);  // O — qtd planejada por série
        linhaMod[16] = loteSeriesParaRespostas;         // Q — loteSeries JSON (só ABERTURA)
        return linhaMod;
      });
      const primeiraLinha = abaRe.getLastRow() + 1;
      abaRe.getRange(primeiraLinha, 1, rows.length, rows[0].length).setValues(rows);
      linhasGravadas = rows.length;
      // Flush após batch write de lote: garante commit de Respostas antes de escrever Abertos.
      // Sem isso, falha no Sheets após Respostas mas antes de Abertos deixa lote "invisível"
      // (existe em Respostas mas operador não aparece como aberto).
      SpreadsheetApp.flush();
    } else if (payload.lote && payload.lote.trim() !== '') {
      // Formato legado — mesma distribuição sem sobra; também não sobrescreve linha[15]
      // (ver comentário acima sobre o bug do elo de pareamento em fechamentos de lote)
      const series = payload.lote.split(',').map(s => s.trim()).filter(Boolean);
      const numSeriesLeg = series.length;
      const qtdPlTotLeg  = Number(payload.qtdPlanejada || 0);
      const qtdReTotLeg  = (qtd === '' ? 0 : Number(qtd));
      const distribuirQtdLeg = (total, n) => {
        if (n <= 0) return [];
        const base  = Math.floor(total / n);
        const resto = total - base * n;
        return Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0));
      };
      const qtdPlPorSerieLeg = distribuirQtdLeg(qtdPlTotLeg, numSeriesLeg);
      const qtdRePorSerieLeg = distribuirQtdLeg(qtdReTotLeg, numSeriesLeg);
      const rows = series.map((serie, idx) => {
        const linhaMod = [...linha];
        linhaMod[5]  = serie + ' | ' + payload.implemento + ' | ' + payload.cliente;
        linhaMod[6]  = qtdRePorSerieLeg[idx];
        linhaMod[14] = String(qtdPlPorSerieLeg[idx]);
        return linhaMod;
      });
      const primeiraLinha = abaRe.getLastRow() + 1;
      abaRe.getRange(primeiraLinha, 1, rows.length, rows[0].length).setValues(rows);
      linhasGravadas = rows.length;
      SpreadsheetApp.flush(); // commit legado também garante atomicidade antes de Abertos
    } else {
      abaRe.appendRow(linha);
    }

    // loteSeriesFechamento já foi preenchido na validação acima (quando tipo === 'FECHAMENTO'
    // e a abertura original era um lote) — reaproveitado aqui no saldo parcial.

    if (paradaAninhadaInfo) {
      // Fix#ParadaAninhada: parada aninhada NÃO toca em Abertos — a ABERTURA/INÍCIO DE
      // RETRABALHO pai continua exatamente como estava, congelada até esta parada fechar.
      // Controle fica isolado em Paradas_Aninhadas (ver garantirAbaParadasAninhadas).
      const abaParadasAn = garantirAbaParadasAninhadas(ss);
      abaParadasAn.appendRow([
        normalizarCodigoOp(payload.operador || ''),
        nomeOperador,
        paradaAninhadaInfo.abertoIdPai,
        paradaAninhadaInfo.tipoPai,
        abertoId,
        tipoFormatado,
        carimbo,
        paradaAninhadaInfo.nrSeriePai,
        paradaAninhadaInfo.codItemPai,
      ]);
    } else if (paradaAninhadaParaFechar) {
      // Fix#ParadaAninhada: fechando uma parada aninhada — remove o controle dedicado.
      // Abertos nunca foi tocado por esta parada, então também não precisa ser tocado aqui;
      // a ABERTURA/INÍCIO DE RETRABALHO pai permanece intocada, pronta para ser fechada
      // normalmente (ou pausada de novo) pelo operador.
      const abaParadasAnFechWrite = garantirAbaParadasAninhadas(ss);
      abaParadasAnFechWrite.deleteRow(paradaAninhadaParaFechar.linhaPlanilha);
    } else {
      // Passa dadosAbertosFresh (lido dentro do lock estreitado, não o snapshot da validação) —
      // atualizarAbertos escreve por ÍNDICE de linha, então precisa do estado mais atual possível.
      atualizarAbertos(abaAb, dadosAbertosFresh, payload, tipo, tipoFormatado, op1, tipoParada, carimbo, abertoId);
    }
    // Bug#1 fix: força commit imediato para que verificarAberto() leia dados atualizados
    SpreadsheetApp.flush();

    // ---------------------------------------------------------------
    // SALDO PARCIAL — salvo no FECHAMENTO
    // Regras:
    //   • saldo = qtdPlanejada − qtdRealizada  (mínimo 0)
    //   • qtdRealizada = 0 quando o operador fecha sem produzir nenhuma peça
    //   • saldo = 0 apaga o registro (produção completa)
    //   • LOTE: salva saldo individualmente para cada série do lote
    //   • Série única: salva saldo para a série específica (se nrSerie não vazio)
    // ---------------------------------------------------------------
    if (tipo === 'FECHAMENTO') {
      const qtdPl = Number(payload.qtdPlanejada || 0);

      const opCod      = String(payload.operacao || '').substring(0, 4);
      const codItemKey = String(payload.codItem || '').trim();
      const operadorNormSaldo = normalizarCodigoOp(payload.operador || '');

      // Saldo por REPLAY determinístico (não por delta): recalcularSaldoParcial reconstrói o
      // saldo de cada chave (NrSerie+CodItem+Operacao) a partir de TODOS os FECHAMENTOs em
      // Respostas, em ordem cronológica. Isso é idempotente por construção — se por qualquer
      // motivo esta gravação for reprocessada, o saldo continua correto (não baixa em dobro),
      // eliminando a classe de bugs de drift/baixa-dobrada do método delta anterior.
      // As linhas de FECHAMENTO desta chamada já foram commitadas (flush acima), então a leitura
      // fresca de Respostas abaixo já as inclui.
      const abaReSaldo = ss.getSheetByName(ABA_RESPOSTAS);
      const dadosReFresh = abaReSaldo ? abaReSaldo.getDataRange().getValues() : null;

      if (loteSeriesFechamento && loteSeriesFechamento.length > 0) {
        // LOTE: recalcula saldo APENAS das séries fechadas agora (payload.loteSeries).
        // qtdPlanejadaTotal = planejado do lote inteiro (rastreabilidade/label na tela).
        // Opção A (perf): recalcularSaldoParcialLote lê/escreve Saldo_Parcial UMA VEZ para
        // todas as séries do lote, em vez de N leituras+escritas independentes (era a parte
        // mais pesada dentro do lock num fechamento de lote grande).
        const qtdPlTotalLote = loteSeriesFechamento.reduce((s, x) => s + (Number(x.qtdPlanejada) || 0), 0);
        const itensLoteSaldo = payload.loteSeries
          .map(item => ({ nrSerie: String(item.nrSerie || '').trim(), codItem: codItemKey, operacao: opCod }))
          .filter(it => it.nrSerie);
        recalcularSaldoParcialLote(itensLoteSaldo, dadosReFresh, {
          operadorCod: operadorNormSaldo,
          qtdPlanejadaTotal: qtdPlTotalLote,
          isLote: true,
        });
      } else {
        // Série única
        const nrSerieKey = String(payload.nrSerie || '').trim();
        if (nrSerieKey) {
          recalcularSaldoParcial(nrSerieKey, codItemKey, opCod, dadosReFresh, {
            operadorCod: operadorNormSaldo,
            qtdPlanejadaTotal: qtdPl,
            isLote: false,
          });
        }
      }
    }
    respOk = { success: true, message: 'Apontamento registrado com sucesso', linhasGravadas: linhasGravadas };
    if (abertoId) respOk.abertoId = abertoId; // presente apenas em ABERTURA, util para o cliente nao precisar chamar verificarAberto
    // Idempotência (parte rápida): persiste em CacheService AINDA dentro do lock estreitado —
    // fecha a janela de um retry muito rápido do mesmo requestId escapar da resposta cacheada
    // e cair de novo nas checagens de duplicidade/fantasma (que já não rodam mais sob o lock
    // global). A escrita durável no IdempotencyLog (mais lenta) fica pra depois de liberar.
    if (reqId) {
      respStr = JSON.stringify(respOk);
      try { CacheService.getScriptCache().put('req_' + reqId, respStr, 21600); } catch(e) {}
    }

    // Invalida o cache curto de getAbertos (Opção A) — cobre tanto o delete de fantasma quanto
    // atualizarAbertos acima, os dois pontos desta função que podem ter mudado a aba Abertos.
    invalidarCacheAbertos();

    } finally {
      lock.releaseLock();
    }

    // Fora do lock estreitado: só a persistência durável (fallback de cache frio). Uma
    // duplicata aqui numa corrida rara é inofensiva — mesmo requestId, mesma resposta já
    // computada e commitada antes do lock ser liberado acima.
    if (reqId && respStr) {
      try {
        const abaLog = garantirAbaIdempotencyLog(ss);
        abaLog.appendRow([reqId, respStr, new Date().toISOString()]);
      } catch(e) {}
    }
    return jsonResponse(respOk);

  } catch (err) {
    _alertarErroSistema('gravarApontamento', err, 'operador=' + (payload.operador || '') + ', tipo=' + (payload.tipoApontamento || ''));
    return jsonResponse({ success: false, message: err.message });
  } finally {
    // Libera o lock por operador (adquirido logo após a sanitização, no início da validação).
    // O lock global estreitado já foi liberado no finally interno, mais acima.
    try { CacheService.getScriptCache().remove(opKey); } catch(e) {}
  }
}

// ================================================================
// CONTROLE DE ABERTOS
// Colunas: 0:Operador 1:Implemento 2:Tipo 3:Operação 4:Carimbo
//          5:CodItem  6:QtdPlanejada 7:NrSerie 8:Implemento 9:Cliente 10:OperadorNome
// ================================================================

// abertoId: ID único gerado na abertura (AP-...) — usado para identificar a linha exata no fechamento
// dadosAbertos: resultado de getDataRange().getValues() já lido pelo caller — evita releitura
// Bug crítico descoberto em produção: um filtro básico ativo (Dados > Criar um filtro) numa
// aba corrompe SILENCIOSAMENTE aba.deleteRow() via Apps Script — a chamada não lança erro e
// o código de quem chamou segue achando que removeu, mas a linha continua lá. Isso explica
// fechamentos que "voltam a aparecer como abertos": a remoção da aba Abertos falhava sem
// avisar. Chamar isto ANTES de qualquer deleteRow nas abas críticas neutraliza o problema.
function removerFiltroSeExistir(aba) {
  try {
    const filtro = aba.getFilter();
    if (filtro) {
      filtro.remove();
      Logger.log('⚠️ Filtro ativo removido na aba "' + aba.getName() + '" antes de deleteRow (evita corrupção silenciosa).');
    }
  } catch (e) {
    Logger.log('removerFiltroSeExistir: ' + e.message);
  }
}

function atualizarAbertos(aba, dadosAbertos, payload, tipo, tipoFormatado, op1, tipoParada, carimbo, abertoId) {
  removerFiltroSeExistir(aba);
  const operador   = normalizarCodigoOp(payload.operador || ''); // sempre 6 dígitos
  const implemento = payload.nrSerie   || payload.implemento || '';
  const dados      = dadosAbertos;

  const tiposAb = ['ABERTURA', 'INICIO_RETRABALHO', 'INICIO_PARADA'];
  const tiposFe = ['FECHAMENTO', 'TERMINO_RETRABALHO', 'TERMINO_PARADA'];

  if (tiposAb.includes(tipo)) {
    const opLabel = op1 || tipoParada || payload.retrabalho || '';
    const _ehLoteAbertura = payload.loteSeries && Array.isArray(payload.loteSeries) && payload.loteSeries.length > 0;
    const novaLinha = [
      operador,                                             // 0  Operador
      implemento,                                           // 1  Implemento
      tipoFormatado,                                        // 2  Tipo
      opLabel,                                              // 3  Operação
      carimbo,                                              // 4  Carimbo
      payload.codItem      || '',                           // 5  CodItem
      payload.qtdPlanejada || '',                           // 6  QtdPlanejada
      payload.nrSerie      || '',                           // 7  NrSerie
      payload.implemento   || '',                           // 8  ImplementoNome
      payload.cliente      || '',                           // 9  Cliente
      payload.operadorNome || '',                           // 10 OperadorNome
      _ehLoteAbertura ? JSON.stringify(payload.loteSeries) : '', // 11 LoteSeries (JSON)
      abertoId || '',                                       // 12 AbertoId — chave de rastreamento
      _ehLoteAbertura ? 'Sim' : 'Não',                     // 13 IsLote — flag explícita (evita heurística de texto)
      '',                                                    // 14 AlertaEnviadoEm — sempre vazio numa abertura nova.
      // Fix#AlertaEnviadoStale: sem este elemento explícito, a sobrescrita de linha existente
      // logo abaixo (getRange(...,novaLinha.length).setValues) só toca as primeiras 14 colunas
      // e deixaria o AlertaEnviadoEm da linha ANTERIOR (outro abertoId) grudado no abertoId
      // NOVO, suprimindo um alerta legítimo futuro pro item errado.
    ];

    // Verifica por operador (não por série) — um aberto por operador
    for (let i = 1; i < dados.length; i++) {
      if (mesmoOperador(dados[i][0], operador)) {
        // Fix#PokaYokeEsquecido: chegar aqui significa que a validação de bloqueio em
        // gravarApontamento já decidiu que era seguro prosseguir (bloqueou ou removeu
        // fantasma antes) — mas se ainda assim sobra uma linha do operador aqui, é porque
        // ela representa uma abertura genuína NUNCA FECHADA. Sobrescrevê-la silenciosamente
        // (comportamento antigo) apaga esse rastro para sempre. Loga um alerta para
        // auditoria/investigação, sem bloquear a gravação (a decisão de permitir já foi
        // tomada antes desta função ser chamada).
        const abertoIdAnterior = String(dados[i][12] || '').trim();
        const tipoAnterior     = String(dados[i][2]  || '').trim();
        if (abertoIdAnterior && abertoIdAnterior !== (abertoId || '')) {
          Logger.log('ALERTA gravarApontamento [PokaYokeEsquecido]: sobrescrevendo aberto ' +
            'não fechado — operador=' + operador + ', tipoAnterior="' + tipoAnterior +
            '", abertoIdAnterior=' + abertoIdAnterior + ', abertoIdNovo=' + (abertoId || '') +
            '. A abertura anterior nunca recebeu fechamento correspondente.');
        }
        aba.getRange(i + 1, 1, 1, novaLinha.length).setValues([novaLinha]);
        aba.getRange(i + 1, 1).setNumberFormat('@');
        return;
      }
    }
    aba.appendRow(novaLinha);
    aba.getRange(aba.getLastRow(), 1).setNumberFormat('@');

  } else if (tiposFe.includes(tipo)) {
    // Preferência: encontrar linha por AbertoId (imune a zeros à esquerda e colisões)
    // Fallback: match por código do operador (compatibilidade com registros sem ID)
    const abertoIdPayload = String(payload.abertoId || '').trim();
    for (let i = dados.length - 1; i >= 1; i--) {
      const rowId   = String(dados[i][12] || '').trim();
      const matchId = abertoIdPayload && rowId && rowId === abertoIdPayload;
      const matchOp = !matchId && mesmoOperador(dados[i][0], operador);
      if (matchId || matchOp) {
        const loteAbertoRaw = String(dados[i][11] || '').trim();
        const loteFechamentoPayload = payload.loteSeries && Array.isArray(payload.loteSeries) && payload.loteSeries.length > 0;

        // Fechamento parcial de lote: remove só as séries fechadas agora, mantém o resto aberto.
        if (loteAbertoRaw && loteFechamentoPayload) {
          let seriesOriginais = [];
          try { seriesOriginais = JSON.parse(loteAbertoRaw); } catch(e) {}
          const nrSeriesFechadasAgora = new Set(payload.loteSeries.map(s => String(s.nrSerie).trim()));
          const restantes = seriesOriginais.filter(s => !nrSeriesFechadasAgora.has(String(s.nrSerie).trim()));

          if (restantes.length > 0) {
            // Ainda sobram séries abertas — atualiza a linha em vez de removê-la
            const qtdPlanejadaRestante = restantes.reduce((soma, s) => soma + (Number(s.qtdPlanejada) || 0), 0);
            aba.getRange(i + 1, 7).setValue(qtdPlanejadaRestante);       // col G (índice 6) — QtdPlanejada
            aba.getRange(i + 1, 12).setValue(JSON.stringify(restantes)); // col L (índice 11) — LoteSeries
            return;
          }
          // restantes.length === 0 → lote inteiro fechado, cai para a remoção normal abaixo
        }

        // Bug fix: Google Sheets não permite excluir TODAS as linhas não-congeladas.
        // Se esta for a última linha de dados (sheet terá só o cabeçalho), limpa o conteúdo
        // da célula em vez de deletar a linha — evita "Não é possível excluir todas as linhas".
        if (aba.getLastRow() <= 2) {
          aba.getRange(i + 1, 1, 1, aba.getLastColumn() || 13).clearContent();
        } else {
          aba.deleteRow(i + 1);
        }
        return;
      }
    }
  }
}

// ================================================================
// CADASTROS DINÂMICOS
// ================================================================

// ================================================================
// GET ABERTOS — lê a aba "Abertos" e retorna os registros abertos
// Chamado pelo dashboard via ?action=getAbertos
// ================================================================
// Opção A (perf): cache curto (30s) — Abertos é pequena (só itens hoje abertos), cabe
// tranquilamente no limite de ~100KB do CacheService (ao contrário de getData/Respostas, que
// NÃO cabe e por isso não ganhou cache nesta rodada). Invalidado ativamente em todo ponto que
// escreve em Abertos (invalidarCacheAbertos, chamado por: atualizarAbertos/delete de fantasma
// dentro de gravarApontamento, reconstruirAbertos, editarApontamento, desfazerFechamentoAction,
// removerRegistroPorAbertoId) — o TTL é só uma rede de segurança, não o mecanismo principal.
function getAbertosAction() {
  try {
    const cache  = CacheService.getScriptCache();
    const cached = cache.get('abertos_v1');
    if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_ABERTOS);
    if (!aba) return jsonResponse({ success: true, abertos: [] });
    const dados = aba.getDataRange().getValues();
    if (dados.length <= 1) {
      const vazio = JSON.stringify({ success: true, abertos: [] });
      try { cache.put('abertos_v1', vazio, 30); } catch(e) {}
      return ContentService.createTextOutput(vazio).setMimeType(ContentService.MimeType.JSON);
    }
    const abertos = [];
    for (let i = 1; i < dados.length; i++) {
      const row = dados[i];
      if (!row[0]) continue; // linha vazia
      let loteSeries = null;
      if (row[11]) {
        try { loteSeries = JSON.parse(String(row[11])); } catch(e) {}
      }
      // col 4 (Carimbo) pode ser Date object no GAS — formatar como string dd/MM/yyyy HH:mm:ss
      const carimboRaw = row[4];
      const carimboStr = carimboRaw instanceof Date
        ? Utilities.formatDate(carimboRaw, 'GMT-3', 'dd/MM/yyyy HH:mm:ss')
        : String(carimboRaw || '');
      abertos.push({
        operador:       String(row[0]  || ''),
        implemento:     String(row[1]  || ''),
        tipo:           String(row[2]  || ''),
        operacao:       String(row[3]  || ''),
        carimbo:        carimboStr,
        codItem:        String(row[5]  || ''),
        qtdPlanejada:   String(row[6]  || ''),
        nrSerie:        String(row[7]  || ''),
        implementoNome: String(row[8]  || ''),
        cliente:        String(row[9]  || ''),
        operadorNome:   String(row[10] || ''),
        loteSeries:     loteSeries,
        abertoId:       String(row[12] || ''),
        isLote:         String(row[13] || '') === 'Sim',
        alertaEnviadoEm: String(row[COL_AB.ALERTA_ENVIADO_EM] || ''),
      });
    }
    const resultado = JSON.stringify({ success: true, abertos: abertos });
    try { cache.put('abertos_v1', resultado, 30); } catch(e) {}
    return ContentService.createTextOutput(resultado).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return jsonResponse({ success: false, erro: err.message });
  }
}

function invalidarCacheAbertos() {
  try { CacheService.getScriptCache().remove('abertos_v1'); } catch(e) {}
}

function getCadastros() {
  try {
    // Cache de 5 min — evita abrir a planilha a cada carregamento de página
    const cache  = CacheService.getScriptCache();
    const cached = cache.get('cadastros_v3');
    if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

    const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
    const abaOp  = garantirAbaCadastro(ss, ABA_OPERADORES, ['Codigo', 'Nome', 'Ativo']);
    const abaSe  = garantirAbaCadastro(ss, ABA_SERIES,     ['NrSerie', 'Implemento', 'Cliente', 'Ativo']);
    const abaOpc = garantirAbaCadastro(ss, ABA_OPERACOES,  ['Codigo', 'Nome', 'ExigeQtd']);

    const operadores = abaOp.getDataRange().getValues().slice(1)
      .filter(r => String(r[2]).toUpperCase() !== 'NÃO' && r[0] !== '')
      .map(r => ({ codigo: normalizarCodigoOp(String(r[0]).trim()), nome: String(r[1]).trim() }));

    const series = abaSe.getDataRange().getValues().slice(1)
      .filter(r => String(r[3]).toUpperCase() !== 'NÃO' && r[0] !== '')
      .map(r => ({ nrSerie: String(r[0]).trim(), implemento: String(r[1]).trim(), cliente: String(r[2]).trim() }));

    // Operações customizadas criadas pelo líder (complementam as built-in do app)
    const operacoesCustom = abaOpc.getDataRange().getValues().slice(1)
      .filter(r => r[0] !== '')
      .map(r => ({
        cod:       String(r[0]).trim(),
        nome:      String(r[1]).trim(),
        requerQtd: String(r[2]).toUpperCase() === 'SIM',
      }));

    const resultado = JSON.stringify({ success: true, operadores, series, operacoesCustom });
    cache.put('cadastros_v3', resultado, 300); // 5 minutos
    return ContentService.createTextOutput(resultado).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }
}

function invalidarCacheCadastros() {
  try {
    const c = CacheService.getScriptCache();
    c.remove('cadastros_v3');
    c.remove('cadastros_v2');     // versão antiga
    c.remove('series_validas_v1'); // cache de séries válidas usado em validação de entrada
  } catch(e) {}
}

// ================================================================
// DADOS DA PLANILHA — lidos sempre frescos (sem cache de CacheService)
// Chamado pelo dashboard via ?action=getData
// Retorna array de objetos com os cabeçalhos da aba Respostas como chaves,
// no mesmo formato que o script antigo de leitura retornava.
// ================================================================
function getDadosRespostas() {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_RESPOSTAS);
    if (!aba) return ContentService.createTextOutput('[]').setMimeType(ContentService.MimeType.JSON);

    const dados    = aba.getDataRange().getValues();
    if (dados.length < 2) return ContentService.createTextOutput('[]').setMimeType(ContentService.MimeType.JSON);

    const cabecalhos = dados[0].map(c => String(c));
    const registros  = [];

    for (let i = 1; i < dados.length; i++) {
      const row = dados[i];
      // Pula linhas completamente vazias
      if (!row[0] && !row[1]) continue;
      const obj = {};
      cabecalhos.forEach((col, j) => {
        const val = row[j];
        // Converte Date objects para string legível
        if (val instanceof Date) {
          obj[col] = Utilities.formatDate(val, 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
        } else {
          obj[col] = val === null || val === undefined ? '' : val;
        }
      });
      registros.push(obj);
    }

    return ContentService
      .createTextOutput(JSON.stringify(registros))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput('[]').setMimeType(ContentService.MimeType.JSON);
  }
}

function salvarOperador(payload) {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaCadastro(ss, ABA_OPERADORES, ['Codigo', 'Nome', 'Ativo']);
    // Normaliza: remove zeros à esquerda (ex: "000130" → "130")
    const codigoNorm = normalizarCodigoOp(String(payload.codigo || '').trim());
    aba.getRange('A:A').setNumberFormat('@');
    const dados = aba.getDataRange().getValues();
    for (let i = 1; i < dados.length; i++) {
      if (mesmoOperador(dados[i][0], codigoNorm)) {
        aba.getRange(i+1, 1).setValue(codigoNorm);
        aba.getRange(i+1, 2).setValue(payload.nome);
        aba.getRange(i+1, 3).setValue('Sim');
        invalidarCacheCadastros();
        return jsonResponse({ success: true, message: 'Operador atualizado.' });
      }
    }
    aba.appendRow([codigoNorm, payload.nome, 'Sim']);
    invalidarCacheCadastros();
    return jsonResponse({ success: true, message: 'Operador adicionado.' });
  } catch (err) { return jsonResponse({ success: false, message: err.message }); }
}

function removerOperador(payload) {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaCadastro(ss, ABA_OPERADORES, ['Codigo', 'Nome', 'Ativo']);
    const dados = aba.getDataRange().getValues();
    for (let i = dados.length-1; i >= 1; i--) {
      if (String(dados[i][0]).trim() === String(payload.codigo).trim()) {
        aba.getRange(i+1,3).setValue('Não');
        invalidarCacheCadastros();
        return jsonResponse({ success: true, message: 'Operador desativado.' });
      }
    }
    return jsonResponse({ success: false, message: 'Operador não encontrado.' });
  } catch (err) { return jsonResponse({ success: false, message: err.message }); }
}

function salvarSerie(payload) {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaCadastro(ss, ABA_SERIES, ['NrSerie', 'Implemento', 'Cliente', 'Ativo']);
    const dados = aba.getDataRange().getValues();
    for (let i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).trim() === String(payload.nrSerie).trim()) {
        aba.getRange(i+1,2).setValue(payload.implemento);
        aba.getRange(i+1,3).setValue(payload.cliente);
        aba.getRange(i+1,4).setValue('Sim');
        return jsonResponse({ success: true, message: 'Série atualizada.' });
      }
    }
    aba.appendRow([payload.nrSerie, payload.implemento, payload.cliente, 'Sim']);
    invalidarCacheCadastros();
    return jsonResponse({ success: true, message: 'Série adicionada.' });
  } catch (err) { return jsonResponse({ success: false, message: err.message }); }
}

function removerSerie(payload) {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaCadastro(ss, ABA_SERIES, ['NrSerie', 'Implemento', 'Cliente', 'Ativo']);
    const dados = aba.getDataRange().getValues();
    for (let i = dados.length-1; i >= 1; i--) {
      if (String(dados[i][0]).trim() === String(payload.nrSerie).trim()) {
        aba.getRange(i+1,4).setValue('Não');
        invalidarCacheCadastros();
        return jsonResponse({ success: true, message: 'Série desativada.' });
      }
    }
    return jsonResponse({ success: false, message: 'Série não encontrada.' });
  } catch (err) { return jsonResponse({ success: false, message: err.message }); }
}

// ================================================================
// OPERAÇÕES CUSTOMIZADAS
// ================================================================

function salvarOperacao(payload) {
  try {
    const cod  = String(payload.cod  || '').trim().toUpperCase();
    const nome = String(payload.nome || '').trim().toUpperCase();
    if (!cod || !nome) return jsonResponse({ success: false, message: 'Código e nome são obrigatórios.' });

    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaCadastro(ss, ABA_OPERACOES, ['Codigo', 'Nome', 'ExigeQtd']);
    const exigeQtd = payload.requerQtd ? 'Sim' : 'Não';

    const dados = aba.getDataRange().getValues();
    for (let i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).trim().toUpperCase() === cod) {
        aba.getRange(i+1, 2).setValue(nome);
        aba.getRange(i+1, 3).setValue(exigeQtd);
        invalidarCacheCadastros();
        return jsonResponse({ success: true, message: 'Operação atualizada.' });
      }
    }
    aba.appendRow([cod, nome, exigeQtd]);
    invalidarCacheCadastros();
    return jsonResponse({ success: true, message: 'Operação adicionada.' });
  } catch (err) { return jsonResponse({ success: false, message: err.message }); }
}

function removerOperacao(payload) {
  try {
    const cod = String(payload.cod || '').trim().toUpperCase();
    if (!cod) return jsonResponse({ success: false, message: 'Código obrigatório.' });

    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaCadastro(ss, ABA_OPERACOES, ['Codigo', 'Nome', 'ExigeQtd']);
    const dados = aba.getDataRange().getValues();
    for (let i = dados.length-1; i >= 1; i--) {
      if (String(dados[i][0]).trim().toUpperCase() === cod) {
        aba.deleteRow(i+1);
        invalidarCacheCadastros();
        return jsonResponse({ success: true, message: 'Operação removida.' });
      }
    }
    return jsonResponse({ success: false, message: 'Operação não encontrada.' });
  } catch (err) { return jsonResponse({ success: false, message: err.message }); }
}

// ================================================================
// HELPERS
// ================================================================

function garantirAbaAbertos(ss) {
  let aba = ss.getSheetByName(ABA_ABERTOS);
  if (!aba) {
    aba = ss.insertSheet(ABA_ABERTOS);
    const cab = ['Operador','Implemento','Tipo','Operação','Carimbo','CodItem','QtdPlanejada','NrSerie','ImplementoNome','Cliente','OperadorNome','LoteSeries','AbertoId','IsLote','AlertaEnviadoEm','CicloId'];
    aba.appendRow(cab);
    aba.setFrozenRows(1);
    aba.getRange(1,1,1,cab.length).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#fff');
    // Formatos de texto definidos apenas na criação — evita chamada custosa a cada requisição
    aba.getRange('A:A').setNumberFormat('@');
    aba.getRange('E:E').setNumberFormat('@'); // carimbo como texto
  } else {
    // Migrações leves: planilhas existentes ganham colunas novas sem perder dados.
    // Não usa "else if" — uma planilha bem antiga (<14 colunas) precisa ganhar todas as seguintes.
    if (aba.getLastColumn() < 14) {
      aba.getRange(1, 14).setValue('IsLote');
      aba.getRange(1, 14).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#fff');
    }
    if (aba.getLastColumn() < 15) {
      aba.getRange(1, 15).setValue('AlertaEnviadoEm');
      aba.getRange(1, 15).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#fff');
    }
    if (aba.getLastColumn() < 16) {
      aba.getRange(1, 16).setValue('CicloId');
      aba.getRange(1, 16).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#fff');
    }
  }
  return aba;
}

// ================================================================
// PARADAS ANINHADAS (Fix#ParadaAninhada) — controle de paradas iniciadas DENTRO de uma
// ABERTURA ou INÍCIO DE RETRABALHO já aberto, sem fechá-lo. Estrutura separada de Abertos
// de propósito: Abertos assume histórico e código existente de "uma linha por operador",
// e essa suposição já causou bugs sutis (Fix#PokaYokeEsquecido) — isolar a parada aninhada
// numa aba própria evita reabrir essa superfície frágil. Enquanto uma linha existir aqui
// para um operador, a ABERTURA/RETRABALHO associado (identificado por AbertoIdPai) continua
// intocado em Abertos — congelado, não fechável, até esta parada ser encerrada.
// Colunas: Operador, OperadorNome, AbertoIdPai, TipoPai, AbertoIdParada, TipoParada, Carimbo,
//          NrSeriePai, CodItemPai (as duas últimas só para contexto legível na planilha).
// ================================================================
function garantirAbaParadasAninhadas(ss) {
  let aba = ss.getSheetByName(ABA_PARADAS_ANINHADAS);
  if (!aba) {
    aba = ss.insertSheet(ABA_PARADAS_ANINHADAS);
    const cab = ['Operador','OperadorNome','AbertoIdPai','TipoPai','AbertoIdParada','TipoParada','Carimbo','NrSeriePai','CodItemPai'];
    aba.appendRow(cab);
    aba.setFrozenRows(1);
    aba.getRange(1,1,1,cab.length).setFontWeight('bold').setBackground('#8e6b1a').setFontColor('#fff');
    aba.getRange('A:A').setNumberFormat('@');
    aba.getRange('C:C').setNumberFormat('@');
    aba.getRange('E:E').setNumberFormat('@');
    aba.getRange('G:G').setNumberFormat('@');
  }
  return aba;
}

function garantirAbaCadastro(ss, nome, cabecalhos) {
  let aba = ss.getSheetByName(nome);
  if (!aba) {
    aba = ss.insertSheet(nome);
    aba.appendRow(cabecalhos);
    aba.setFrozenRows(1);
    aba.getRange(1,1,1,cabecalhos.length).setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
  }
  return aba;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Gera ID único no formato AP-XXXXXXXXXX
function gerarIdApontamento() {
  return 'AP-' + Utilities.getUuid().replace(/-/g,'').substring(0, 10).toUpperCase();
}

// cicloId — identidade persistente do ciclo de produção (nrSerie+codItem+operacao), reaproveitada
// entre reaberturas de baixa parcial. Prefixo diferente de gerarIdApontamento() de propósito —
// nunca deve ser confundido com abertoId se colado no campo errado.
function gerarCicloId() {
  return 'CI-' + Utilities.getUuid().replace(/-/g,'').substring(0, 10).toUpperCase();
}

// Normaliza código de operador: Sheets converte '000130' → número 130.
// Comparar como número evita falsos negativos por zeros à esquerda.
// Formata valor lido da planilha como data/hora em pt-BR (dd/MM/yyyy HH:mm:ss)
// Cobre três casos:
//   1. Date object  — Sheets auto-converteu a string para Date
//   2. String inglesa — código antigo fez String(date) → "Thu May 14 2026 12:15:07 GMT-0300..."
//   3. String já em pt-BR — retorna como está
function formatarCarimboGs(val) {
  if (!val) return '';
  // Caso 1: objeto Date (Google Sheets auto-detectou célula como data)
  if (val instanceof Date) return Utilities.formatDate(val, 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
  const s = String(val).trim();
  if (!s) return '';
  // Caso 2: já no formato dd/MM/yyyy
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return s;
  // Caso 3: ISO timestamp "2026-06-09T18:52:00.000Z" ou "2026-06-09T18:52:00Z"
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) {
        return Utilities.formatDate(d, 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
      }
    } catch(e) {}
    return s; // fallback: devolve como está
  }
  // Caso 4: string inglesa "Thu May 14 2026 12:15:07 GMT-0300 ..."
  // (GAS converte Date → String com toLocaleString inglês)
  // Extrai componentes via regex — não depende de new Date() que pode falhar com caracteres especiais
  const m = s.match(/\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const MESES = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
    const mes = MESES[m[1]];
    if (mes) {
      return String(m[2]).padStart(2,'0') + '/' + String(mes).padStart(2,'0') + '/' + m[3] +
             ' ' + m[4] + ':' + m[5] + ':' + m[6];
    }
  }
  return s;
}

/**
 * Converte string "dd/MM/yyyy HH:mm:ss" (saída de formatarCarimboGs) em milissegundos.
 * Evita o bug de new Date('09/06/2026') que, no V8 do GAS, interpreta DD como mês (MM/DD).
 */
function parseCarimboGsMs(s) {
  if (!s) return NaN;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return new Date(
    parseInt(m[3]),     // year
    parseInt(m[2]) - 1, // month (0-indexed)
    parseInt(m[1]),     // day
    parseInt(m[4]),     // hour
    parseInt(m[5]),     // minute
    parseInt(m[6])      // second
  ).getTime();
}

/**
 * Lê linha bruta da aba Respostas → objeto com nomes de campo.
 * ÚNICO lugar que conhece COL_RE. Qualquer acesso a colunas de Respostas passa por aqui.
 */
function lerLinhaRespostas(row) {
  const serieRaw = String(row[COL_RE.SERIE] || '').trim();
  const partes   = serieRaw.split(' | ');
  return {
    carimbo:      formatarCarimboGs(row[COL_RE.CARIMBO]),
    operador:     String(row[COL_RE.OPERADOR]      || '').trim(),
    tipo:         String(row[COL_RE.TIPO]           || '').trim(),
    operacao:     String(row[COL_RE.OPERACAO]       || '').trim(),
    codItem:      String(row[COL_RE.COD_ITEM]       || '').trim(),
    serieRaw:     serieRaw,
    nrSerie:      (partes[0] || '').trim(),
    implemento:   (partes[1] || '').trim(),
    cliente:      (partes[2] || '').trim(),
    qtd:          row[COL_RE.QTD],
    tipoParada:   String(row[COL_RE.TIPO_PARADA]    || '').trim(),
    tipoRetrab:   String(row[COL_RE.TIPO_RETRAB]    || '').trim(),
    tipoSetup:    String(row[COL_RE.TIPO_SETUP]     || '').trim(),
    operacao2:    String(row[COL_RE.OPERACAO2]      || '').trim(),
    qtdPlanejada: row[COL_RE.QTD_PLANEJADA]         || '',
    abertoId:     String(row[COL_RE.ABERTO_ID]      || '').trim(),
  };
}

/**
 * Lê linha bruta da aba Abertos → objeto com nomes de campo.
 * ÚNICO lugar que conhece COL_AB.
 */
function lerLinhaAbertos(row) {
  let loteSeries = null;
  if (row[COL_AB.LOTE_SERIES]) {
    try { loteSeries = JSON.parse(String(row[COL_AB.LOTE_SERIES])); } catch(e) {}
  }
  return {
    operador:       String(row[COL_AB.OPERADOR]        || '').trim(),
    implemento:     String(row[COL_AB.IMPLEMENTO]      || '').trim(),
    tipo:           String(row[COL_AB.TIPO]            || '').trim(),
    operacao:       String(row[COL_AB.OPERACAO]        || '').trim(),
    carimbo:        formatarCarimboGs(row[COL_AB.CARIMBO]),
    codItem:        String(row[COL_AB.COD_ITEM]        || '').trim(),
    qtdPlanejada:   row[COL_AB.QTD_PLANEJADA]          || '',
    nrSerie:        String(row[COL_AB.NR_SERIE]        || '').trim(),
    implementoNome: String(row[COL_AB.IMPLEMENTO_NOME] || '').trim(),
    cliente:        String(row[COL_AB.CLIENTE]         || '').trim(),
    operadorNome:   String(row[COL_AB.OPERADOR_NOME]   || '').trim(),
    loteSeries:     loteSeries,
    abertoId:       String(row[COL_AB.ABERTO_ID]       || '').trim(),
    isLote:         String(row[COL_AB.IS_LOTE]         || '') === 'Sim',
  };
}

function mesmoOperador(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const na = Number(sa);
  const nb = Number(sb);
  return !isNaN(na) && na !== 0 && !isNaN(nb) && nb !== 0 && na === nb;
}

// Normaliza código de operador: retorna APENAS o número sem zeros à esquerda.
// Ex: "000130" → "130",  "130" → "130",  130 (número) → "130"
// Estratégia sem zeros — novos registros já chegam nesse formato naturalmente.
function normalizarCodigoOp(val) {
  const s = String(val === null || val === undefined ? '' : val).trim();
  if (!s) return s;
  const n = Number(s);
  // número puro positivo: retorna sem zeros à esquerda
  if (!isNaN(n) && n > 0 && String(n) === s) return String(n);
  // string com zeros à esquerda (ex: "000130"): remove zeros
  const semZeros = s.replace(/^0+(\d)/, '$1');
  const nSem = Number(semZeros);
  if (!isNaN(nSem) && nSem > 0) return String(nSem);
  return s;
}

// ================================================================
// SALDO PARCIAL
// Colunas: 0:NrSerie 1:CodItem 2:Operacao 3:QtdRestante 4:UltimaAtualizacao
// ================================================================

// Arquivamento — aba com o MESMO schema de ABA_RESPOSTAS (cabeçalho copiado da aba viva,
// não hardcoded, pra nunca dessincronizar se uma coluna nova for adicionada em Respostas).
function garantirAbaHistorico(ss) {
  let aba = ss.getSheetByName(ABA_HISTORICO);
  if (!aba) {
    aba = ss.insertSheet(ABA_HISTORICO);
    const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
    const cabecalho = abaRe ? abaRe.getRange(1, 1, 1, abaRe.getLastColumn()).getValues()[0] : [];
    if (cabecalho.length > 0) {
      aba.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]);
      aba.setFrozenRows(1);
      aba.getRange(1, 1, 1, cabecalho.length).setFontWeight('bold').setBackground('#5a5a5a').setFontColor('#fff');
    }
  }
  return aba;
}

// Leitura mesclada Historico + Respostas, no MESMO formato de abaRe.getDataRange().getValues()
// (cabeçalho no índice 0, dados a partir do índice 1). Historico guarda dados mais antigos que
// a aba viva — prepend antes de Respostas preserva a ordem cronológica que o replay de saldo e
// as auditorias assumem. Usada só por caminhos frios (auditorias de histórico completo e
// ferramentas administrativas que podem mirar num registro já arquivado) — o caminho quente de
// escrita (gravarApontamento/recalcularSaldoParcial) nunca chama isto, ver Contexto do plano.
function _lerRespostasComHistorico(ss) {
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  const dadosRe = abaRe ? abaRe.getDataRange().getValues() : [[]];
  const abaHist = ss.getSheetByName(ABA_HISTORICO);
  if (!abaHist || abaHist.getLastRow() < 2) return dadosRe;
  const dadosHist = abaHist.getDataRange().getValues();
  return [dadosRe[0] || dadosHist[0]].concat(dadosHist.slice(1)).concat(dadosRe.slice(1));
}

// ================================================================
// ARQUIVAMENTO DE HISTÓRICO
// ================================================================

function _carimboArquivamentoMs(raw) {
  const ms = parseCarimboGsMs(formatarCarimboGs(raw));
  return isNaN(ms) ? null : ms;
}

// Identifica os abertoIds inteiros seguros para arquivar. Duas regras de elegibilidade,
// por tipo de ciclo:
//  - Ciclos ABERTURA→FECHAMENTO: sujeitos à regra "zero-crossing" de _calcularSaldoReplay
//    (linha ~2602) — só é seguro arquivar um FECHAMENTO estritamente anterior ao último
//    "reset" da sua chave (nrSerie+codItem+operacao), porque o replay do saldo nunca olha
//    pra trás desse ponto. Um lote com N séries só é elegível quando TODAS as N séries já
//    cruzaram essa fronteira — nunca parcialmente (senão o FECHAMENTO de uma série ainda
//    ativa sumiria do replay da sua própria chave).
//  - Ciclos INÍCIO/TÉRMINO DE RETRABALHO e paradas standalone: não tocam Saldo_Parcial (só
//    FECHAMENTO entra no replay), então só precisam estar FECHADOS (têm o evento de término)
//    + margem de segurança — sem risco de zero-crossing.
// Em ambos os casos, também vale ARQUIVAMENTO_MARGEM_DIAS (dataLimiteMs) — não arquiva nada
// fechado recentemente, pra deixar folga para correções administrativas via editarApontamento.
// Retorna o Set de abertoIds elegíveis. Quem chama usa esse conjunto para incluir toda linha
// cujo ABERTO_ID (ou ABERTO_ID_PAI, no caso de paradas/retrabalhos aninhados) esteja nele —
// a unidade de arquivamento é sempre o abertoId inteiro, nunca uma linha isolada.
// Regra "re-baseia ao zerar", extraída pra um lugar só depois de existir em duas cópias quase-
// idênticas no arquivo (_calcularSaldoReplay e _identificarElegiveisArquivamento). Recebe uma
// lista de eventos JÁ EM ORDEM CRONOLÓGICA (cada um só precisa de qtdPlanejada/qtdRealizada) e
// devolve o saldo final da chave e a posição do último "reset" — o evento que recomeçou o ciclo
// do zero porque o saldo anterior já tinha zerado. Dali em diante é o "ciclo ativo" atual.
function _derivarLimitesDeCiclo(eventos) {
  let saldo = null;
  let ultimoResetPos = 0;
  eventos.forEach((ev, pos) => {
    if (saldo === null || saldo <= 0) {
      saldo = Math.max(0, ev.qtdPlanejada - ev.qtdRealizada);
      ultimoResetPos = pos;
    } else {
      saldo = Math.max(0, saldo - ev.qtdRealizada);
    }
  });
  return { saldoFinal: saldo, ultimoResetPos };
}

function _identificarElegiveisArquivamento(dadosRe, dataLimiteMs) {
  const TIPOS_FECHAMENTO_AUX = new Set(['TÉRMINO DE RETRABALHO', 'TÉRMINO DE PARADA']);

  const porChave = {};                 // chave -> [{idx, carimboMs, qtdPlanejada, qtdRealizada, abertoId}]
  const fechamentoAuxPorAbertoId = {};  // abertoId -> carimboMs do término (retrabalho/parada standalone)

  for (let i = 1; i < dadosRe.length; i++) {
    const row = dadosRe[i];
    const tipo = String(row[COL_RE.TIPO] || '').trim();
    const abertoId = String(row[COL_RE.ABERTO_ID] || '').trim();
    if (tipo === 'FECHAMENTO') {
      const nrSerie  = String(row[COL_RE.SERIE] || '').split('|')[0].trim();
      const codItem  = String(row[COL_RE.COD_ITEM] || '').trim();
      const operacao = String(row[COL_RE.OPERACAO] || '').substring(0, 4);
      const chave = nrSerie + '::' + codItem + '::' + operacao;
      if (!porChave[chave]) porChave[chave] = [];
      porChave[chave].push({
        idx: i,
        carimboMs: _carimboArquivamentoMs(row[COL_RE.CARIMBO]),
        qtdPlanejada: Number(row[COL_RE.QTD_PLANEJADA]) || 0,
        qtdRealizada: Number(row[COL_RE.QTD]) || 0,
        abertoId: abertoId,
      });
    } else if (TIPOS_FECHAMENTO_AUX.has(tipo) && abertoId) {
      fechamentoAuxPorAbertoId[abertoId] = _carimboArquivamentoMs(row[COL_RE.CARIMBO]);
    }
  }

  // Replay por chave (mesma regra de _calcularSaldoReplay) — marca quais índices de FECHAMENTO
  // ficam estritamente antes do último reset (ou, se a chave zerou no fim, TODOS os eventos).
  const idxFechamentoElegivel = new Set();
  const fechamentosPorAbertoId = {}; // abertoId -> [idx, ...] — todos os FECHAMENTOs daquele id
  Object.keys(porChave).forEach(chave => {
    const eventos = porChave[chave];
    // Bookkeeping de fechamentosPorAbertoId não faz parte da matemática de reset — passa antes,
    // não importa a ordem.
    eventos.forEach(ev => {
      if (ev.abertoId) (fechamentosPorAbertoId[ev.abertoId] || (fechamentosPorAbertoId[ev.abertoId] = [])).push(ev.idx);
    });
    const { saldoFinal, ultimoResetPos } = _derivarLimitesDeCiclo(eventos);
    const limitePos = (saldoFinal === 0) ? eventos.length : ultimoResetPos;
    for (let pos = 0; pos < limitePos; pos++) {
      const ev = eventos[pos];
      if (ev.abertoId && ev.carimboMs && ev.carimboMs < dataLimiteMs) idxFechamentoElegivel.add(ev.idx);
    }
  });

  const abertoIdsElegiveis = new Set();
  // Um abertoId de lote pode ter N FECHAMENTOs (um por série) — só elegível se TODOS cruzaram
  // a fronteira de segurança, nunca parcialmente.
  Object.keys(fechamentosPorAbertoId).forEach(id => {
    const idxs = fechamentosPorAbertoId[id];
    if (idxs.every(idx => idxFechamentoElegivel.has(idx))) abertoIdsElegiveis.add(id);
  });
  Object.keys(fechamentoAuxPorAbertoId).forEach(id => {
    if (abertoIdsElegiveis.has(id)) return; // não deveria colidir com a regra acima, mas por garantia
    const ms = fechamentoAuxPorAbertoId[id];
    if (ms && ms < dataLimiteMs) abertoIdsElegiveis.add(id);
  });

  return abertoIdsElegiveis;
}

// Expande o Set de abertoIds elegíveis pra todos os índices de linha (em dadosRe) que devem
// se mover junto — a própria ABERTURA/FECHAMENTO(s) do id, e qualquer linha aninhada (parada/
// retrabalho) cujo ABERTO_ID_PAI aponte pra ele.
function _linhasParaArquivar(dadosRe, abertoIdsElegiveis) {
  const idxs = [];
  for (let i = 1; i < dadosRe.length; i++) {
    const row = dadosRe[i];
    const meuId = String(row[COL_RE.ABERTO_ID] || '').trim();
    const idPai = String(row[COL_RE.ABERTO_ID_PAI] || '').trim();
    if ((meuId && abertoIdsElegiveis.has(meuId)) || (idPai && abertoIdsElegiveis.has(idPai))) {
      idxs.push(i);
    }
  }
  return idxs;
}

function _preencherColunas(row, numColunas) {
  if (row.length === numColunas) return row;
  const r = row.slice(0, numColunas);
  while (r.length < numColunas) r.push('');
  return r;
}

// Dry-run: identifica o que SERIA arquivado, sem mover nada. Espelha o padrão já usado em
// previewAberturasOrfas/deletarAberturasOrfas (linha ~7203) pra uma operação destrutiva similar.
function previewArquivamento(margemDias) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  if (!abaRe) return { success: false, message: 'Aba Respostas não encontrada.' };
  const dadosRe = abaRe.getDataRange().getValues();
  if (dadosRe.length < 2) return { success: true, abertoIdsElegiveis: 0, linhasElegiveis: 0, amostra: [] };

  // Number(margemDias) > 0 trataria "0" como "nao informado" (0 e falsy) — checa presenca
  // explicitamente, pra permitir margemDias=0 (usado em teste, arquiva tudo elegivel na hora).
  const diasNum = Number(margemDias);
  const dias = (margemDias !== undefined && margemDias !== null && margemDias !== '' && !isNaN(diasNum) && diasNum >= 0)
    ? diasNum : ARQUIVAMENTO_MARGEM_DIAS;
  const dataLimiteMs = Date.now() - dias * 24 * 60 * 60 * 1000;

  const abertoIdsElegiveis = _identificarElegiveisArquivamento(dadosRe, dataLimiteMs);
  const idxs = _linhasParaArquivar(dadosRe, abertoIdsElegiveis);

  const amostra = idxs.slice(0, 20).map(i => ({
    sheetRow: i + 1,
    carimbo:  formatarCarimboGs(dadosRe[i][COL_RE.CARIMBO]),
    tipo:     dadosRe[i][COL_RE.TIPO],
    nrSerie:  String(dadosRe[i][COL_RE.SERIE] || '').split('|')[0].trim(),
    codItem:  dadosRe[i][COL_RE.COD_ITEM],
    abertoId: dadosRe[i][COL_RE.ABERTO_ID],
  }));

  return {
    success: true,
    margemDias: dias,
    totalLinhasRespostas: dadosRe.length - 1,
    abertoIdsElegiveis: abertoIdsElegiveis.size,
    linhasElegiveis: idxs.length,
    amostra: amostra,
  };
}

// Move de verdade as linhas elegíveis pra Historico. Nunca faz deleteRow em loop linha-a-linha
// (O(n²) numa aba com milhares de linhas) — calcula o estado final em memória (mantidas vs.
// arquivadas) e escreve tudo de uma vez, mesmo padrão de recalcularSaldoParcialLote (~linha 2692).
// Segura o lock global (mesma seção crítica de gravarApontamento) — corre em horário de baixo
// tráfego (trigger diário de madrugada), então bloquear escritas durante essa janela é aceitável.
function executarArquivamento(margemDias) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return { success: false, message: 'Servidor ocupado. Tente novamente em instantes.' };
  }
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
    if (!abaRe) return { success: false, message: 'Aba Respostas não encontrada.' };
    const dadosRe = abaRe.getDataRange().getValues();
    if (dadosRe.length < 2) return { success: true, arquivados: 0, message: 'Sem dados.' };

    // Number(margemDias) > 0 trataria "0" como "nao informado" (0 e falsy) — checa presenca
  // explicitamente, pra permitir margemDias=0 (usado em teste, arquiva tudo elegivel na hora).
  const diasNum = Number(margemDias);
  const dias = (margemDias !== undefined && margemDias !== null && margemDias !== '' && !isNaN(diasNum) && diasNum >= 0)
    ? diasNum : ARQUIVAMENTO_MARGEM_DIAS;
    const dataLimiteMs = Date.now() - dias * 24 * 60 * 60 * 1000;

    const abertoIdsElegiveis = _identificarElegiveisArquivamento(dadosRe, dataLimiteMs);
    const idxsArquivar = new Set(_linhasParaArquivar(dadosRe, abertoIdsElegiveis));

    if (idxsArquivar.size === 0) {
      return { success: true, arquivados: 0, message: 'Nenhuma linha elegível pra arquivar.' };
    }

    const linhasMantidas   = [dadosRe[0]];
    const linhasArquivadas = [];
    for (let i = 1; i < dadosRe.length; i++) {
      if (idxsArquivar.has(i)) linhasArquivadas.push(dadosRe[i]);
      else linhasMantidas.push(dadosRe[i]);
    }

    const abaHist = garantirAbaHistorico(ss);
    const numColunas = Math.max(abaRe.getLastColumn(), abaHist.getLastColumn());

    // Append em lote no Historico, preservando a ordem cronológica das linhas arquivadas.
    const proximaLinhaHist = abaHist.getLastRow() + 1;
    abaHist.getRange(proximaLinhaHist, 1, linhasArquivadas.length, numColunas)
      .setValues(linhasArquivadas.map(r => _preencherColunas(r, numColunas)));

    // Reescreve Respostas: limpa o corpo e escreve só as linhas mantidas.
    if (dadosRe.length > 1) {
      abaRe.getRange(2, 1, dadosRe.length - 1, numColunas).clearContent();
    }
    if (linhasMantidas.length > 1) {
      abaRe.getRange(2, 1, linhasMantidas.length - 1, numColunas)
        .setValues(linhasMantidas.slice(1).map(r => _preencherColunas(r, numColunas)));
    }
    SpreadsheetApp.flush();

    return {
      success: true,
      arquivados: linhasArquivadas.length,
      abertoIdsArquivados: abertoIdsElegiveis.size,
      restantesEmRespostas: linhasMantidas.length - 1,
      message: linhasArquivadas.length + ' linha(s) movida(s) pra ' + ABA_HISTORICO + '.',
    };
  } finally {
    lock.releaseLock();
  }
}

function garantirAbaSaldo(ss) {
  let aba = ss.getSheetByName(ABA_SALDO);
  if (!aba) {
    aba = ss.insertSheet(ABA_SALDO);
    const cab = ['NrSerie','CodItem','Operacao','QtdRestante','UltimaAtualizacao','AbertoId','OperadorCod','QtdPlanejadaTotal','IsLote','CicloId'];
    aba.appendRow(cab);
    aba.setFrozenRows(1);
    aba.getRange(1,1,1,cab.length).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    // Formatos de texto definidos apenas na criação — evita chamada custosa a cada requisição
    aba.getRange('A:A').setNumberFormat('@'); // NrSerie
    aba.getRange('B:B').setNumberFormat('@'); // CodItem
    aba.getRange('C:C').setNumberFormat('@'); // Operacao ← crítico: '0010' vira 10 sem isso
    aba.getRange('E:E').setNumberFormat('@'); // UltimaAtualizacao
    aba.getRange('F:F').setNumberFormat('@'); // AbertoId
    aba.getRange('G:G').setNumberFormat('@'); // OperadorCod
  } else if (aba.getLastColumn() < 6) {
    // Migração: adiciona AbertoId
    aba.getRange(1, 6).setValue('AbertoId');
    aba.getRange(1, 6).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    aba.getRange('F:F').setNumberFormat('@');
    aba.getRange(1, 7).setValue('OperadorCod');
    aba.getRange(1, 8).setValue('QtdPlanejadaTotal');
    aba.getRange(1, 9).setValue('IsLote');
    aba.getRange(1, 7, 1, 3).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    aba.getRange('G:G').setNumberFormat('@');
  } else if (aba.getLastColumn() < 9) {
    // Migração leve: planilhas com AbertoId ganham as 3 novas colunas de rastreabilidade
    aba.getRange(1, 7).setValue('OperadorCod');
    aba.getRange(1, 8).setValue('QtdPlanejadaTotal');
    aba.getRange(1, 9).setValue('IsLote');
    aba.getRange(1, 7, 1, 3).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    aba.getRange('G:G').setNumberFormat('@');
  } else if (aba.getLastColumn() < 10) {
    // Migração leve: adiciona CicloId (identidade persistente do ciclo, separada de AbertoId)
    aba.getRange(1, 10).setValue('CicloId');
    aba.getRange(1, 10).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    aba.getRange('J:J').setNumberFormat('@');
  }
  return aba;
}

// ================================================================
// ANÁLISES DE IA — armazena a última análise gerada por tipo (diario/semanal).
// Colunas: 0:Data 1:Tipo 2:Texto
// Mantém só 1 linha por Tipo (sobrescreve a anterior) — não cresce indefinidamente.
// ================================================================
function garantirAbaAnaliseIA(ss) {
  let aba = ss.getSheetByName(ABA_ANALISES_IA);
  if (!aba) {
    aba = ss.insertSheet(ABA_ANALISES_IA);
    const cab = ['Data', 'Tipo', 'Texto'];
    aba.appendRow(cab);
    aba.setFrozenRows(1);
    aba.getRange(1, 1, 1, cab.length).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    aba.getRange('A:A').setNumberFormat('@'); // Data ← evita autoconversão do Sheets p/ Date nativo
  }
  return aba;
}

// qtdPlanejada: planejado do ciclo atual (usado só se não houver saldo anterior)
// qtdRealizada: produzido neste ciclo (sempre subtraído do saldo existente ou do planejado)
// Regra de acumulação:
//   • Há saldo anterior  → novoSaldo = saldoAnterior - qtdRealizada
//   • Sem saldo anterior → novoSaldo = qtdPlanejada  - qtdRealizada  (primeiro ciclo)
//   • novoSaldo ≤ 0      → remove o registro (produção concluída)
// abertoId (opcional): só rastreabilidade — não faz parte da chave de busca (NrSerie+CodItem+
// Operacao continua sendo a chave, como sempre foi), grava o abertoId da abertura que gerou
// este saldo para permitir agrupar saldos pendentes por lote de origem.
//
// ⚠️ DEPRECADO (v4.4): o fluxo de fechamento passou a usar recalcularSaldoParcial (replay
// determinístico de todos os FECHAMENTOs em Respostas), que é idempotente e não sofre de
// drift/baixa-dobrada como este método por delta. Mantido apenas como referência histórica —
// não há mais chamadas. Não reintroduzir sem entender que o replay é a fonte de verdade.
function atualizarSaldoParcial(aba, nrSerie, codItem, operacao, qtdPlanejada, qtdRealizada, carimbo, abertoId, operadorCod, qtdPlanejadaTotal, isLote) {
  const dados = aba.getDataRange().getValues();
  const codItemNorm = String(codItem || '').trim();

  // Coleta todos os índices que batem na chave composta
  const matches = [];
  for (let i = 1; i < dados.length; i++) {
    if (
      mesmoOperador(dados[i][0], nrSerie) &&
      String(dados[i][1] || '').trim() === codItemNorm &&
      mesmoOperador(dados[i][2], operacao)
    ) {
      matches.push(i);
    }
  }

  // Calcula o novo saldo
  let novoSaldo;
  if (matches.length > 0) {
    // Há saldo acumulado — subtrai o que foi produzido neste ciclo
    const saldoAtual = Number(dados[matches[0]][3]) || 0;
    novoSaldo = Math.max(0, saldoAtual - qtdRealizada);
  } else {
    // Primeiro ciclo — base é a qtdPlanejada
    if (qtdPlanejada <= 0) return; // sem planejado e sem saldo → nada a fazer
    novoSaldo = Math.max(0, qtdPlanejada - qtdRealizada);
  }

  // Remove duplicatas de baixo para cima
  for (let k = matches.length - 1; k >= 1; k--) {
    aba.deleteRow(matches[k] + 1);
  }

  if (matches.length === 0) {
    if (novoSaldo > 0) {
      aba.appendRow([
        nrSerie, codItem, operacao, novoSaldo, carimbo,
        abertoId         || '',
        operadorCod      || '',
        (qtdPlanejadaTotal != null ? qtdPlanejadaTotal : qtdPlanejada) || '',
        isLote ? 'Sim' : 'Não',
      ]);
    }
    return;
  }

  const linha = matches[0] + 1;
  if (novoSaldo <= 0) {
    aba.deleteRow(linha);
  } else {
    aba.getRange(linha, 3).setValue(operacao);
    aba.getRange(linha, 4).setValue(novoSaldo);
    aba.getRange(linha, 5).setValue(carimbo);
    aba.getRange(linha, 6).setValue(abertoId || dados[matches[0]][5] || '');
    if (operadorCod)    aba.getRange(linha, 7).setValue(operadorCod);
    if (qtdPlanejadaTotal != null) aba.getRange(linha, 8).setValue(qtdPlanejadaTotal);
    if (isLote !== undefined) aba.getRange(linha, 9).setValue(isLote ? 'Sim' : 'Não');
  }
}

// Recalcula o saldo parcial de uma chave (NrSerie+CodItem+Operacao) DO ZERO, "replay"
// de todos os FECHAMENTOs dessa chave em ordem cronológica — em vez de aplicar um delta
// na cima do valor acumulado existente. Necessário porque editarApontamento pode alterar
// um FECHAMENTO antigo cujo efeito já foi "consumido" por fechamentos posteriores; um
// delta simples ficaria incorreto nesse cenário, enquanto o replay sempre reflete a
// realidade atual da planilha, não importa quantas edições aconteçam.
// dadosRePreCarregado (opcional): array já lido por quem chamou (mesma forma de
// getDataRange().getValues(), com cabeçalho na posição 0), refletindo o estado ATUAL
// (pós-edição/remoção) da planilha. Quando fornecido, evita uma releitura completa
// redundante — usado por editarApontamento e removerRegistroPorAbertoId, que já têm
// os dados em memória no momento em que chamam esta função.
// Replay puro em memória (nenhuma leitura/escrita de Saldo_Parcial aqui) — extraído de
// recalcularSaldoParcial pra ser reaproveitado por recalcularSaldoParcialLote sem duplicar a
// lógica de replay. Reconstrói o saldo de uma chave (NrSerie+CodItem+Operacao) a partir de
// TODOS os FECHAMENTOs em Respostas, em ordem cronológica — mesma regra de "re-baseia ao
// zerar" de sempre.
function _calcularSaldoReplay(nrSerie, codItemNorm, operacao, dadosRe) {
  const eventos = [];
  for (let i = 1; i < dadosRe.length; i++) {
    if (String(dadosRe[i][COL_RE.TIPO] || '').trim() !== 'FECHAMENTO') continue;
    const serieLinha = String(dadosRe[i][COL_RE.SERIE] || '').split('|')[0].trim();
    const itemLinha  = String(dadosRe[i][COL_RE.COD_ITEM] || '').trim();
    const opLinha    = String(dadosRe[i][COL_RE.OPERACAO] || '').substring(0, 4);
    if (!mesmoOperador(serieLinha, nrSerie)) continue;
    if (itemLinha !== codItemNorm) continue;
    if (!mesmoOperador(opLinha, operacao)) continue;
    // OperadorCod: Respostas col B guarda o NOME completo ("000117 - RAFAEL..."); extraímos o
    // primeiro grupo de dígitos (o código) e normalizamos. Necessário para o filtro dono-only
    // de verificarSaldoLotesAction funcionar também nos saldos gerados por replay.
    const nomeOpLinha = String(dadosRe[i][COL_RE.OPERADOR] || '');
    const mCod = nomeOpLinha.match(/\d+/);
    eventos.push({
      qtdPlanejada: Number(dadosRe[i][COL_RE.QTD_PLANEJADA]) || 0,
      qtdRealizada: Number(dadosRe[i][COL_RE.QTD]) || 0,
      carimbo: dadosRe[i][COL_RE.CARIMBO],
      abertoId: String(dadosRe[i][COL_RE.ABERTO_ID] || '').trim(),
      operadorCod: mCod ? normalizarCodigoOp(mCod[0]) : '',
    });
  }

  // Regra "re-baseia ao zerar": um novo fechamento cujo ciclo anterior já foi concluído
  // (saldo == 0) inicia um NOVO ciclo de produção — recomeça do plano DELE, não subtrai de 0.
  // Sem isto, reabrir uma série já concluída (H2.2) com um plano novo daria saldo errado,
  // pois o replay só olharia o plano do primeiro fechamento. Com a regra, o replay reproduz
  // exatamente o comportamento do método delta (que zerava removendo a linha), porém de forma
  // determinística e idempotente — reprocessar a mesma gravação nunca baixa o saldo em dobro.
  // (lógica de reset compartilhada com _identificarElegiveisArquivamento via _derivarLimitesDeCiclo)
  const { saldoFinal, ultimoResetPos } = _derivarLimitesDeCiclo(eventos);
  const ultimo = eventos.length ? eventos[eventos.length - 1] : null;
  let ultimoOperador = '';
  for (let i = eventos.length - 1; i >= 0; i--) {
    if (eventos[i].operadorCod) { ultimoOperador = eventos[i].operadorCod; break; }
  }

  return {
    saldo: saldoFinal,
    ultimoCarimbo: ultimo ? ultimo.carimbo : '',
    ultimoAbertoId: ultimo ? ultimo.abertoId : '',
    ultimoOperador,
    baseQtdPlanejada: eventos.length ? eventos[ultimoResetPos].qtdPlanejada : null,
  };
}

function recalcularSaldoParcial(nrSerie, codItem, operacao, dadosRePreCarregado, opts) {
  if (!nrSerie || !codItem) return;
  const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaSaldo = garantirAbaSaldo(ss);
  let dadosRe = dadosRePreCarregado;
  if (!dadosRe) {
    const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
    if (!abaRe) return;
    dadosRe = abaRe.getDataRange().getValues();
  }
  const codItemNorm = String(codItem).trim();
  const { saldo, ultimoCarimbo, ultimoAbertoId, ultimoOperador, baseQtdPlanejada } =
    _calcularSaldoReplay(nrSerie, codItemNorm, operacao, dadosRe);

  const dadosSaldo = abaSaldo.getDataRange().getValues();
  for (let i = dadosSaldo.length - 1; i >= 1; i--) {
    if (mesmoOperador(dadosSaldo[i][0], nrSerie) && String(dadosSaldo[i][1] || '').trim() === codItemNorm && mesmoOperador(dadosSaldo[i][2], operacao)) {
      abaSaldo.deleteRow(i + 1);
    }
  }
  if (saldo !== null && saldo > 0) {
    // OperadorCod/QtdPlanejadaTotal/IsLote: derivados do replay (operador do último evento,
    // planejado do primeiro ciclo). O caller pode sobrescrever via opts quando tiver o valor
    // exato (ex.: fechamento de lote informa qtdPlanejadaTotal do lote inteiro e isLote=true).
    const operadorCod = (opts && opts.operadorCod) || ultimoOperador || '';
    const qtdPlTotal  = (opts && opts.qtdPlanejadaTotal != null) ? opts.qtdPlanejadaTotal
                       : (baseQtdPlanejada != null ? baseQtdPlanejada : '');
    const isLoteFlag  = (opts && opts.isLote != null) ? (opts.isLote ? 'Sim' : 'Não') : '';
    abaSaldo.appendRow([nrSerie, codItem, operacao, saldo, ultimoCarimbo, ultimoAbertoId, operadorCod, qtdPlTotal, isLoteFlag]);
  }
}

// Opção A (perf): versão em lote de recalcularSaldoParcial — lê e escreve Saldo_Parcial UMA
// VEZ para todas as N séries de um lote, em vez de N leituras+escritas independentes (era a
// parte mais pesada dentro do lock num fechamento de lote grande). Nunca faz deleteRow dentro
// de um loop por série contra o mesmo array compartilhado — isso invalidaria o índice da
// próxima série. Calcula o estado final em memória e escreve tudo de uma vez no final.
// itens: [{nrSerie, codItem, operacao}, ...]. opts: mesmo formato de recalcularSaldoParcial,
// aplicado a todas as chaves (correto para o caso real — um fechamento de lote tem o mesmo
// operadorCod/qtdPlanejadaTotal/isLote pra todas as séries fechadas na mesma chamada).
function recalcularSaldoParcialLote(itens, dadosReFresh, opts) {
  if (!Array.isArray(itens) || itens.length === 0) return;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaSaldo = garantirAbaSaldo(ss);
  const dadosSaldo = abaSaldo.getDataRange().getValues();
  const numColunas = Math.max(abaSaldo.getLastColumn(), 9);

  const chaves = itens
    .map(it => ({
      nrSerie: String(it.nrSerie || '').trim(),
      codItem: String(it.codItem || '').trim(),
      operacao: it.operacao,
    }))
    .filter(c => c.nrSerie && c.codItem);
  if (chaves.length === 0) return;

  // Mantém toda linha existente que NÃO pertence a nenhuma das chaves sendo recalculadas.
  const linhasMantidas = [];
  for (let i = 1; i < dadosSaldo.length; i++) {
    const row = dadosSaldo[i];
    if (!row[0] && !row[1]) continue; // linha vazia
    const pertence = chaves.some(c =>
      mesmoOperador(row[0], c.nrSerie) &&
      String(row[1] || '').trim() === c.codItem &&
      mesmoOperador(row[2], c.operacao)
    );
    if (!pertence) linhasMantidas.push(row);
  }

  // Calcula (replay puro, em memória — nenhuma I/O aqui) a linha nova de cada chave.
  const linhasNovas = [];
  chaves.forEach(c => {
    const r = _calcularSaldoReplay(c.nrSerie, c.codItem, c.operacao, dadosReFresh);
    if (r.saldo !== null && r.saldo > 0) {
      const operadorCod = (opts && opts.operadorCod) || r.ultimoOperador || '';
      const qtdPlTotal  = (opts && opts.qtdPlanejadaTotal != null) ? opts.qtdPlanejadaTotal
                         : (r.baseQtdPlanejada != null ? r.baseQtdPlanejada : '');
      const isLoteFlag  = (opts && opts.isLote != null) ? (opts.isLote ? 'Sim' : 'Não') : '';
      linhasNovas.push([c.nrSerie, c.codItem, c.operacao, r.saldo, r.ultimoCarimbo, r.ultimoAbertoId, operadorCod, qtdPlTotal, isLoteFlag]);
    }
  });

  const linhasFinais = linhasMantidas.concat(linhasNovas);
  // Reescreve o corpo da aba de uma vez: limpa e escreve o estado final calculado.
  if (dadosSaldo.length > 1) {
    abaSaldo.getRange(2, 1, dadosSaldo.length - 1, numColunas).clearContent();
  }
  if (linhasFinais.length > 0) {
    abaSaldo.getRange(2, 1, linhasFinais.length, numColunas).setValues(linhasFinais);
  }
}

// ================================================================
// CONFIRMAÇÃO DE FECHAMENTO JÁ REGISTRADO — usado pela fila offline do frontend antes de
// descartar um item por "semAberto" (servidor não achou a abertura correspondente). Esse
// erro acontece tanto quando o fechamento JÁ foi aplicado numa tentativa anterior (a resposta
// que não chegou ao cliente — descartar é seguro) quanto em erros genuínos (abertura nunca
// existiu, foi removida por outro motivo — descartar SEM checar perderia o apontamento
// silenciosamente). Esta action permite o frontend diferenciar os dois casos checando se há
// de fato uma linha do tipo esperado gravada para aquele abertoId, antes de remover da fila.
function verificarFechamentoRegistradoAction(abertoId, tipo) {
  try {
    const idAlvo = String(abertoId || '').trim();
    const tipoFormatado = TIPOS_APONTAMENTO[tipo] || tipo;
    if (!idAlvo || !tipoFormatado) return jsonResponse({ registrado: false });
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_RESPOSTAS);
    if (!aba) return jsonResponse({ registrado: false });
    const dados = aba.getDataRange().getValues();
    for (let i = 1; i < dados.length; i++) {
      if (String(dados[i][COL_RE.ABERTO_ID] || '').trim() !== idAlvo) continue;
      if (String(dados[i][COL_RE.TIPO] || '').trim() !== tipoFormatado) continue;
      return jsonResponse({ registrado: true });
    }
    return jsonResponse({ registrado: false });
  } catch (err) {
    // Erro ao verificar: NÃO assume nem sucesso nem falha — frontend trata como "incerto"
    // e mantém na fila para tentar de novo, em vez de arriscar descartar um apontamento real.
    return jsonResponse({ registrado: null, erro: err.message });
  }
}

// ================================================================
// ALERTA DE ERRO DE SISTEMA — para exceções INESPERADAS no backend (bug, cota do Google,
// timeout do Sheets etc.), não para rejeições de validação normais (success:false esperado,
// isso não é "problema do sistema"). Diferente de notificarFalhaPermanenteAction (que o
// frontend aciona quando a fila offline desiste): este dispara do próprio backend sempre que
// gravarApontamento ou a reconciliação periódica (reconstruirAbertos) lançam uma exceção não
// tratada — hoje isso era engolido silenciosamente, virando só uma mensagem genérica de erro
// pro operador, sem ninguém da equipe ficar sabendo.
// Throttle via CacheService: no máx. 1 e-mail a cada 20min por origem — evita virar spam se o
// mesmo erro repetir em rajada (o que faria a caixa de entrada ser ignorada, na prática
// desligando o alerta).
function _alertarErroSistema(origem, err, contexto) {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'alerta_erro_' + origem;
    if (cache.get(cacheKey)) return; // já alertou recentemente para essa origem — evita spam
    cache.put(cacheKey, '1', 1200); // 20 min

    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">' +
      '<h3 style="color:#c0392b">🔥 Erro de sistema — AGRICEF</h3>' +
      '<p>Uma exceção inesperada ocorreu em <strong>' + origem + '</strong>. Isso é diferente de uma ' +
      'rejeição de validação normal — indica um bug ou falha de infraestrutura (cota do Google, ' +
      'timeout do Sheets etc.) que pode estar afetando outros apontamentos também.</p>' +
      '<table style="border-collapse:collapse;margin-top:8px">' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Erro</td><td style="padding:4px 10px">' + (err && err.message || String(err)) + '</td></tr>' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Horário</td><td style="padding:4px 10px">' + Utilities.formatDate(new Date(), 'GMT-3', 'dd/MM/yyyy HH:mm:ss') + '</td></tr>' +
      (contexto ? '<tr><td style="padding:4px 10px;font-weight:bold">Contexto</td><td style="padding:4px 10px">' + contexto + '</td></tr>' : '') +
      '</table>' +
      (err && err.stack ? '<p style="margin-top:10px;font-size:11px;color:#888;white-space:pre-wrap">' + err.stack + '</p>' : '') +
      '</div>';
    MailApp.sendEmail({
      to:       EMAIL_ALERTA_FALHA,
      subject:  '🔥 AGRICEF | Erro de sistema — ' + origem,
      htmlBody: html,
    });
  } catch (alertErr) {
    Logger.log('_alertarErroSistema: falha ao enviar alerta — ' + alertErr.message);
  }
}

// ================================================================
// ALERTA DE FALHA PERMANENTE NA FILA OFFLINE — o frontend chama isso quando um apontamento
// esgota as tentativas de reenvio automático (fila local do operador) e é movido para a fila
// de falhas permanentes. Sem isso, a única forma de alguém saber que um apontamento real se
// perdeu seria o operador notar o toast "contate o suporte" no próprio aparelho — fácil de
// passar desapercebido em ambiente de fábrica. Fire-and-forget: o frontend não bloqueia nem
// depende da resposta desta action.
function notificarFalhaPermanenteAction(payloadJson) {
  try {
    const item = JSON.parse(payloadJson || '{}');
    const tipoLabel = TIPOS_APONTAMENTO[item.tipoApontamento] || item.tipoApontamento || '—';
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">' +
      '<h3 style="color:#c0392b">⛔ Apontamento não sincronizado — AGRICEF</h3>' +
      '<p>Um apontamento ficou retido no dispositivo do operador e <strong>não foi registrado na base</strong> ' +
      'após várias tentativas automáticas de reenvio. O operador provavelmente precisará refazê-lo manualmente, ' +
      'mas convém confirmar com ele e verificar a conexão do dispositivo usado.</p>' +
      '<table style="border-collapse:collapse;margin-top:8px">' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Operador</td><td style="padding:4px 10px">' + (item.operadorNome || item.operador || '—') + '</td></tr>' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Tipo</td><td style="padding:4px 10px">' + tipoLabel + '</td></tr>' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Série/Implemento</td><td style="padding:4px 10px">' + (item.nrSerie || item.implemento || '—') + '</td></tr>' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Código do item</td><td style="padding:4px 10px">' + (item.codItem || '—') + '</td></tr>' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Horário original</td><td style="padding:4px 10px">' + (item.timestamp || item.hora || '—') + '</td></tr>' +
      '<tr><td style="padding:4px 10px;font-weight:bold">Salvo offline em</td><td style="padding:4px 10px">' + (item._salvoEm || '—') + '</td></tr>' +
      '</table>' +
      '</div>';
    MailApp.sendEmail({
      to:       EMAIL_ALERTA_FALHA,
      subject:  '⛔ AGRICEF | Apontamento não sincronizado — ' + (item.operadorNome || item.operador || ''),
      htmlBody: html,
    });
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }
}

// ================================================================
// JUSTIFICATIVAS DE AUDITORIA — permite ao líder justificar uma inconsistência de "duração
// suspeita" do painel de Auditoria do dashboard, removendo-a da contagem ativa (mas mantendo
// rastro: aparece numa seção "Justificadas" separada, nunca apagada silenciosamente).
// Chave: combinação func+openTs+closeTs (única o suficiente na prática, já que pairRows não
// expõe o abertoId) — calculada da mesma forma no dashboard e aqui.
// ================================================================
function garantirAbaJustificativas(ss) {
  let aba = ss.getSheetByName(ABA_JUSTIFICATIVAS);
  if (!aba) {
    aba = ss.insertSheet(ABA_JUSTIFICATIVAS);
    const cab = ['Chave', 'Tipo', 'Justificativa', 'Detalhe', 'DataHora'];
    aba.appendRow(cab);
    aba.setFrozenRows(1);
    aba.getRange(1, 1, 1, cab.length).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
    aba.getRange('A:A').setNumberFormat('@'); // Chave
    aba.getRange('E:E').setNumberFormat('@'); // DataHora
  }
  return aba;
}

function getJustificativasAuditoriaAction() {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaJustificativas(ss);
    const dados = aba.getDataRange().getValues();
    const justificativas = [];
    for (let i = 1; i < dados.length; i++) {
      if (!dados[i][0]) continue;
      justificativas.push({
        chave: String(dados[i][0]),
        tipo: String(dados[i][1] || ''),
        justificativa: String(dados[i][2] || ''),
        detalhe: String(dados[i][3] || ''),
        dataHora: String(dados[i][4] || ''),
      });
    }
    return jsonResponse({ success: true, justificativas: justificativas });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message, justificativas: [] });
  }
}

function salvarJustificativaAuditoriaAction(payload) {
  if (!_adminAutorizado(payload.key)) return jsonResponse({ success: false, message: 'Não autorizado.' });
  const chave = String(payload.chave || '').trim();
  const justificativa = String(payload.justificativa || '').trim();
  if (!chave) return jsonResponse({ success: false, message: 'Chave é obrigatória.' });
  if (!justificativa) return jsonResponse({ success: false, message: 'Justificativa não pode ser vazia.' });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return jsonResponse({ success: false, transiente: true, message: 'Servidor ocupado. Tente novamente em instantes.' });
  }
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaJustificativas(ss);
    const dados = aba.getDataRange().getValues();
    // Idempotente: se a chave já existe, sobrescreve (permite o líder corrigir o texto depois)
    let linhaExistente = -1;
    for (let i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).trim() === chave) { linhaExistente = i + 1; break; }
    }
    const carimbo = Utilities.formatDate(new Date(), 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
    const linha = [chave, String(payload.tipo || ''), justificativa, String(payload.detalhe || ''), carimbo];
    if (linhaExistente > 0) {
      aba.getRange(linhaExistente, 1, 1, linha.length).setValues([linha]);
    } else {
      aba.appendRow(linha);
    }
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  } finally {
    lock.releaseLock();
  }
}

// Permite desfazer uma justificativa (ex: líder digitou errado, ou quer que o item volte a
// contar como inconsistência ativa). Não exposta na UI ainda — uso administrativo via URL.
function removerJustificativaAuditoriaAction(chave, key) {
  if (!_adminAutorizado(key)) return jsonResponse({ success: false, message: 'Não autorizado.' });
  const chaveAlvo = String(chave || '').trim();
  if (!chaveAlvo) return jsonResponse({ success: false, message: 'Chave é obrigatória.' });
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = garantirAbaJustificativas(ss);
    const dados = aba.getDataRange().getValues();
    for (let i = dados.length - 1; i >= 1; i--) {
      if (String(dados[i][0]).trim() === chaveAlvo) {
        aba.deleteRow(i + 1);
        return jsonResponse({ success: true, removido: true });
      }
    }
    return jsonResponse({ success: true, removido: false });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }
}

// ================================================================
// DESFAZER FECHAMENTO — remove a(s) linha(s) de FECHAMENTO indevidas (engano do líder/operador)
// e recria a entrada na aba Abertos a partir da linha de ABERTURA original (mesmo abertoId),
// como se o fechamento nunca tivesse acontecido. A linha de ABERTURA no histórico nunca é
// tocada — só o FECHAMENTO é removido e o operador volta a aparecer como "em aberto".
// Lote: remove TODAS as linhas de FECHAMENTO daquele abertoId e restaura TODAS as séries
// originais como pendentes (não tenta reconstruir um fechamento parcial anterior — se o lote
// já tinha sido fechado em partes antes deste fechamento, isso precisa ser resolvido manual).
// ================================================================
function desfazerFechamentoAction(abertoId, key) {
  if (!_adminAutorizado(key)) return jsonResponse({ success: false, message: 'Não autorizado.' });
  const idAlvo = String(abertoId || '').trim();
  if (!idAlvo) return jsonResponse({ success: false, message: 'abertoId é obrigatório.' });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return jsonResponse({ success: false, transiente: true, message: 'Servidor ocupado. Tente novamente em instantes.' });
  }
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
    const abaAb = garantirAbaAbertos(ss);
    if (!abaRe) return jsonResponse({ success: false, message: 'Aba de respostas não encontrada.' });

    const dadosRe = abaRe.getDataRange().getValues();
    const linhasAbertura = [];
    const linhasFechamentoIdx = [];
    for (let i = 1; i < dadosRe.length; i++) {
      if (String(dadosRe[i][COL_RE.ABERTO_ID] || '').trim() !== idAlvo) continue;
      const tipo = String(dadosRe[i][COL_RE.TIPO] || '').trim();
      if (tipo === 'ABERTURA') linhasAbertura.push(dadosRe[i]);
      if (tipo === 'FECHAMENTO') linhasFechamentoIdx.push(i);
    }

    if (linhasAbertura.length === 0) {
      return jsonResponse({ success: false, message: 'Nenhuma ABERTURA encontrada para este abertoId — não é possível restaurar.' });
    }
    if (linhasFechamentoIdx.length === 0) {
      return jsonResponse({ success: false, message: 'Nenhum FECHAMENTO encontrado para este abertoId.' });
    }

    const ehLote = linhasAbertura.length > 1;
    // COL_RE.OPERADOR guarda "código — nome completo" (ex: "121 — JOÃO..."), não só o código —
    // precisa extrair o código antes de normalizar, senão a entrada em Abertos fica com o
    // operador errado e nunca é reconhecida quando o operador selecionar seu código de novo.
    const operadorRaw = String(linhasAbertura[0][COL_RE.OPERADOR] || '');
    const operadorCod = operadorRaw.split(/[\s\-—]+/)[0].trim();
    const operadorNorm = normalizarCodigoOp(operadorCod);

    // Bloqueia se o operador já tem outra abertura ativa agora — restaurar sobrescreveria
    // um apontamento real e diferente. Precisa ser resolvido manualmente nesse caso.
    const dadosAbertosAntes = abaAb.getDataRange().getValues();
    for (let i = 1; i < dadosAbertosAntes.length; i++) {
      if (mesmoOperador(dadosAbertosAntes[i][COL_AB.OPERADOR], operadorNorm)) {
        return jsonResponse({ success: false, message: 'O operador já possui outro apontamento em aberto agora — restaure manualmente para não sobrescrever.' });
      }
    }

    // Remove as linhas de FECHAMENTO de baixo para cima (não invalida índices das anteriores)
    linhasFechamentoIdx.sort((a,b)=>b-a).forEach(idx => abaRe.deleteRow(idx + 1));

    // Recalcula saldo parcial de cada série/item/operação envolvida — remover o fechamento
    // pode ter "consumido" um saldo que precisa voltar a existir.
    const dadosRePosRemocao = abaRe.getDataRange().getValues();
    const chavesVistas = new Set();
    linhasAbertura.forEach(ab => {
      const serie = String(ab[COL_RE.SERIE] || '').split('|')[0].trim();
      const item  = String(ab[COL_RE.COD_ITEM] || '').trim();
      const op    = String(ab[COL_RE.OPERACAO] || '').substring(0,4);
      const chave = serie+'||'+item+'||'+op;
      if (!chavesVistas.has(chave) && serie && item) {
        chavesVistas.add(chave);
        recalcularSaldoParcial(serie, item, op, dadosRePosRemocao);
      }
    });

    // Recria a entrada na aba Abertos a partir da abertura original
    const abPrincipal = linhasAbertura[0];
    const carimboAbertura = abPrincipal[COL_RE.CARIMBO] instanceof Date
      ? Utilities.formatDate(abPrincipal[COL_RE.CARIMBO], 'GMT-3', 'dd/MM/yyyy HH:mm:ss')
      : String(abPrincipal[COL_RE.CARIMBO] || '');

    let loteSeriesJson = '', qtdPlanejadaTotal = 0, nrSerieUnica = '', implementoUnico = '', clienteUnico = '';
    if (ehLote) {
      const loteSeries = linhasAbertura.map(ab => {
        const partes = String(ab[COL_RE.SERIE] || '').split('|').map(s=>s.trim());
        const qtdPl = Number(ab[COL_RE.QTD_PLANEJADA]) || 0;
        qtdPlanejadaTotal += qtdPl;
        return { nrSerie: partes[0]||'', implemento: partes[1]||'', cliente: partes[2]||'', qtdPlanejada: qtdPl };
      });
      loteSeriesJson = JSON.stringify(loteSeries);
    } else {
      const partes = String(abPrincipal[COL_RE.SERIE] || '').split('|').map(s=>s.trim());
      nrSerieUnica = partes[0]||''; implementoUnico = partes[1]||''; clienteUnico = partes[2]||'';
      qtdPlanejadaTotal = Number(abPrincipal[COL_RE.QTD_PLANEJADA]) || 0;
    }

    const novaLinha = [
      operadorNorm,
      ehLote ? 'LOTE' : nrSerieUnica,
      'ABERTURA',
      String(abPrincipal[COL_RE.OPERACAO] || ''),
      carimboAbertura,
      String(abPrincipal[COL_RE.COD_ITEM] || ''),
      String(qtdPlanejadaTotal || ''),
      ehLote ? '' : nrSerieUnica,
      ehLote ? 'LOTE' : implementoUnico,
      ehLote ? '' : clienteUnico,
      String(abPrincipal[COL_RE.OPERADOR] || ''),
      loteSeriesJson,
      idAlvo,
    ];
    abaAb.appendRow(novaLinha);
    abaAb.getRange(abaAb.getLastRow(), 1).setNumberFormat('@');
    invalidarCacheAbertos(); // Opção A: nova linha em Abertos — invalida o cache curto

    return jsonResponse({ success: true, linhasFechamentoRemovidas: linhasFechamentoIdx.length, ehLote: ehLote });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  } finally {
    lock.releaseLock();
  }
}

function verificarSaldoParcialAction(nrSerie, codItem, operacao) {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_SALDO);
    if (!aba) return jsonResponse({ temSaldo: false });
    const dados = aba.getDataRange().getValues();
    const codItemNorm = String(codItem || '').trim();
    // Chave composta: NrSerie + CodItem + Operacao
    for (let i = 1; i < dados.length; i++) {
      if (
        mesmoOperador(dados[i][0], nrSerie) &&
        String(dados[i][1] || '').trim() === codItemNorm &&
        mesmoOperador(dados[i][2], operacao)
      ) {
        const qtd = Number(dados[i][3]);
        if (qtd > 0) {
          return jsonResponse({
            temSaldo: true,
            qtdRestante: qtd,
            ultimaAtualizacao: String(dados[i][4]),
            abertoId: String(dados[i][5] || ''),
          });
        }
      }
    }
    return jsonResponse({ temSaldo: false });
  } catch (err) {
    return jsonResponse({ temSaldo: false, erro: err.message });
  }
}

// ================================================================
// LOTES COM SALDO PENDENTE — agrupa Saldo_Parcial por AbertoId para permitir
// "reabrir lote para séries restantes" em vez de reabrir série por série.
// Só agrupa linhas que têm AbertoId preenchido (saldos antigos, gravados antes
// desta coluna existir, continuam funcionando no fluxo de série única — não aparecem
// aqui, mas também não quebram nada).
// ================================================================
// Retorna os lotes/séries com saldo pendente PERTENCENTES ao operador informado.
// Regra confirmada (dono-only): cada operador só vê e reabre os próprios saldos pendentes —
// evita que o saldo de um colega apareça na tela de quem não abriu o apontamento.
// Filtro: coluna 6 (OperadorCod) do Saldo_Parcial. Saldos legados/replay podem ter OperadorCod
// vazio (gravados antes desta coluna, ou por recalcularSaldoParcial em versões antigas); nesses
// casos reconstruímos o dono via abertoId → aba Abertos. Se ainda assim não for possível
// determinar o dono, o saldo é OMITIDO (fail-closed) — melhor não mostrar do que mostrar a quem
// não é dono. Sem operador informado, retorna vazio (compatibilidade defensiva: nunca vaza tudo).
function verificarSaldoLotesAction(operador) {
  try {
    const operadorReq = normalizarCodigoOp(String(operador || '').trim());
    if (!operadorReq) return jsonResponse({ success: true, lotes: [] });

    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_SALDO);
    if (!aba) return jsonResponse({ success: true, lotes: [] });
    const dados = aba.getDataRange().getValues();

    // Índice abertoId → operadorCod, montado sob demanda a partir da aba Abertos para
    // resolver o dono de saldos com OperadorCod vazio (legado). Lazy: só lê Abertos se preciso.
    let mapaDonoPorAberto = null;
    const donoDoAberto = (abertoId) => {
      if (!abertoId) return '';
      if (mapaDonoPorAberto === null) {
        mapaDonoPorAberto = {};
        try {
          const abaAb = ss.getSheetByName(ABA_ABERTOS);
          if (abaAb) {
            const dadosAb = abaAb.getDataRange().getValues();
            for (let j = 1; j < dadosAb.length; j++) {
              const aid = String(dadosAb[j][COL_AB.ABERTO_ID] || '').trim();
              if (aid) mapaDonoPorAberto[aid] = normalizarCodigoOp(String(dadosAb[j][COL_AB.OPERADOR] || ''));
            }
          }
        } catch (e) { /* Abertos indisponível — mapaDonoPorAberto fica vazio */ }
      }
      return mapaDonoPorAberto[abertoId] || '';
    };

    const porAbertoId = {};
    for (let i = 1; i < dados.length; i++) {
      const abertoId = String(dados[i][5] || '').trim();
      const qtd = Number(dados[i][3]) || 0;
      if (!abertoId || qtd <= 0) continue;

      // Dono do saldo: preferir OperadorCod (col 6); se vazio, reconstruir via Abertos.
      let donoCod = normalizarCodigoOp(String(dados[i][6] || '').trim());
      if (!donoCod) donoCod = donoDoAberto(abertoId);
      // Fail-closed: sem dono identificável, não mostra a ninguém.
      if (!donoCod || !mesmoOperador(donoCod, operadorReq)) continue;

      if (!porAbertoId[abertoId]) {
        porAbertoId[abertoId] = {
          abertoId: abertoId,
          codItem: String(dados[i][1] || '').trim(),
          operacao: String(dados[i][2] || '').trim(),
          ultimaAtualizacao: String(dados[i][4] || ''),
          isLote: String(dados[i][8] || '').trim().toLowerCase() === 'sim',
          series: [],
        };
      }
      porAbertoId[abertoId].series.push({
        nrSerie: String(dados[i][0] || '').trim(),
        qtdRestante: qtd,
      });
    }
    return jsonResponse({ success: true, lotes: Object.values(porAbertoId) });
  } catch (err) {
    return jsonResponse({ success: false, erro: err.message, lotes: [] });
  }
}

// ================================================================
// UTILITÁRIOS
// ================================================================

function setup() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  garantirAbaAbertos(ss);
  garantirAbaSaldo(ss);
  garantirAbaCadastro(ss, ABA_OPERADORES, ['Codigo','Nome','Ativo']);
  garantirAbaCadastro(ss, ABA_SERIES,     ['NrSerie','Implemento','Cliente','Ativo']);
  garantirAbaCadastro(ss, ABA_OPERACOES,  ['Codigo','Nome','ExigeQtd']);

  const abaOp = ss.getSheetByName(ABA_OPERADORES);
  if (abaOp.getLastRow() <= 1) {
    abaOp.getRange(2,1,15,3).setValues([
      ['000101','ELENILTON GONÇALVES DOS SANTOS','Sim'],
      ['000108','SIDNEI OLIVEIRA','Sim'],
      ['000109','DANIEL DO NASCIMENTO PISNO SILVA','Sim'],
      ['000117','RAFAEL MENDES DA SILVA','Sim'],
      ['000119','JONAS GABRIEL SILVA SANTOS','Sim'],
      ['000121','JOÃO PEDRO ALMEIDA FERREIRA','Sim'],
      ['000123','ADILSON BATISTA DA SILVA FILHO','Sim'],
      ['000128','GILMARCIO OLIVEIRA DOS SANTOS','Sim'],
      ['000130','EDERSON LUIS CANDINHO','Sim'],
      ['000131','MATHEUS FERREIRA DA SILVA','Sim'],
      ['001943','CELSO RODRIGUES DE OLIVEIRA','Sim'],
      ['003102','LUIS GUILHERME NASCIMENTO DOS SANTOS','Sim'],
      ['003766','MATHEUS STUCHI','Sim'],
      ['004077','PAULO JOAQUIM DE SANTANA','Sim'],
      ['004223','DEIVI RODRIGO DIAS DA ROSA','Sim'],
    ]);
  }

  const abaSe = ss.getSheetByName(ABA_SERIES);
  if (abaSe.getLastRow() <= 1) {
    abaSe.getRange(2,1,22,4).setValues([
      ['22000072','HAULER 8"','COFCO','Sim'],
      ['22000073','HAULER 10"','SÃO MARTINHO','Sim'],
      ['22000074','HAULER 10"','ATVOS','Sim'],
      ['22000075','HAULER 10"','ATVOS','Sim'],
      ['22000076','IRRIGAÍ 3 LINHAS','DEXCO','Sim'],
      ['22000077','HAULER 10"','ATVOS','Sim'],
      ['22000078','HAULER 10"','ATVOS','Sim'],
      ['22000079','IRRIGAÍ 3 LINHAS','DEMONSTRAÇÃO','Sim'],
      ['22000080','HAULER 10"','ATVOS','Sim'],
      ['22000081','HAULER 10"','VAMOS MG','Sim'],
      ['22000082','HAULER 10"','VAMOS MG','Sim'],
      ['22000083','IRRIGAÍ 3 LINHAS','DEMONSTRAÇÃO','Sim'],
      ['22000084','PLANTADORA','J. LUIZ','Sim'],
      ['22000085','IRRIGAÍ 2 LINHAS','GERDAU','Sim'],
      ['22000086','HAULER 10"','VAMOS RJ','Sim'],
      ['22000087','HAULER 10"','VAMOS RJ','Sim'],
      ['22000088','HAULER 10"','ESTOQUE','Sim'],
      ['INSTITUCIONAL','INSTITUCIONAL AGRICEF','INTERNO','Sim'],
      ['SUCESSO','SUCESSO DO CLIENTE','INTERNO','Sim'],
      ['ENGENHARIA','ENGENHARIA','INTERNO','Sim'],
      ['SENSOR','SENSOR VISION','INTERNO','Sim'],
      ['ESTOQUE','ESTOQUE','INTERNO','Sim'],
    ]);
  }
  Logger.log('Setup completo.');
}

// Corrige registros antigos de Saldo_Parcial onde operacao foi salva como número (ex: 10 em vez de '0010')
// Execute UMA VEZ após atualizar o script
function corrigirSaldoParcial() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = garantirAbaSaldo(ss);
  const dados = aba.getDataRange().getValues();
  let corrigidos = 0;
  for (let i = 1; i < dados.length; i++) {
    const opValor = dados[i][2];
    // Se a operação é um número (ex: 10), converte para string com zero à esquerda (ex: '0010')
    if (typeof opValor === 'number' || (typeof opValor === 'string' && !isNaN(Number(opValor)) && String(Number(opValor)) === String(opValor).trim())) {
      const opCorrigida = String(Number(opValor)).padStart(4, '0');
      aba.getRange(i + 1, 3).setValue(opCorrigida);
      corrigidos++;
    }
  }
  Logger.log(corrigidos + ' registro(s) de operação corrigido(s) na aba Saldo_Parcial.');
}

// Atualiza cabeçalhos da aba Respostas para nomear as colunas O e P corretamente
// Execute uma vez após atualizar o script
function atualizarCabecalhos() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) { Logger.log('Aba Respostas não encontrada.'); return; }
  aba.getRange(1, 15).setValue('QTD PLANEJADA');
  aba.getRange(1, 16).setValue('ID');
  Logger.log('Cabeçalhos atualizados: coluna O = QTD PLANEJADA, coluna P = ID');
}

// Cria o cabeçalho da coluna R (índice 17, COL_RE.ABERTO_ID_PAI) usada pelo suporte a
// parada aninhada (Fix#ParadaAninhada) — roda uma vez, idempotente.
function _adicionarColunaAbertoIdPai() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) { Logger.log('Aba Respostas não encontrada.'); return; }
  aba.getRange(1, 18).setValue('AbertoId Pai (Parada Aninhada)');
  aba.getRange('R:R').setNumberFormat('@');
  Logger.log('Coluna R (AbertoId Pai) criada em Respostas.');
}

// IMPORTANTE: rode isso para limpar registros ruins da aba Abertos
function limparAbertos() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_ABERTOS);
  if (!aba) { Logger.log('Aba Abertos não existe.'); return; }
  const ultima = aba.getLastRow();
  if (ultima < 1) { Logger.log('Aba vazia (sem cabeçalho). Nada removido.'); return; }
  const removidos = Math.max(0, ultima - 1);
  if (removidos > 0) aba.deleteRows(2, removidos);
  Logger.log(removidos + ' registro(s) removido(s).');
}

// ================================================================
// Bug#29 — RECONSTRUÇÃO DA ABA ABERTOS A PARTIR DE RESPOSTAS
//
// Reconstrói completamente a aba Abertos percorrendo toda a aba
// Respostas em ordem cronológica. Para cada operador mantém estado
// de "último tipo aberto"; se não houver fechamento correspondente,
// o registro vai para o novo Abertos.
//
// Garante consistência mesmo após edição manual das planilhas,
// falha parcial de escrita ou qualquer outra dessincronização.
//
// Invocado:
//   • Manualmente via ?action=reconstruirAbertos&key=AGF2026
//   • Automaticamente pelo trigger a cada 30 min (se ativado)
// ================================================================

function reconstruirAbertos() {
  // Fix#RaceCondition: adquire o mesmo lock que gravarApontamento usa.
  // Se gravarApontamento estiver em execução, pula esta rodada e tenta
  // na próxima chamada do trigger (30 min depois).
  // tryLock(10000) = aguarda até 10s antes de desistir.
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(10000)) {
      Logger.log('reconstruirAbertos: lock ocupado — pulando esta execução para evitar race condition');
      return { corrigidos: 0, abertos: 0, mensagem: 'Skipped: lock ocupado por outra operação' };
    }
  } catch(lockErr) {
    Logger.log('reconstruirAbertos: erro ao adquirir lock — ' + lockErr.message);
    return { corrigidos: 0, abertos: 0, mensagem: 'Erro ao adquirir lock: ' + lockErr.message };
  }

  try {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  const abaAb = garantirAbaAbertos(ss);

  if (!abaRe) {
    Logger.log('reconstruirAbertos: aba Respostas não encontrada.');
    return { corrigidos: 0, abertos: 0, mensagem: 'Aba Respostas não encontrada.' };
  }

  const dadosRe = abaRe.getDataRange().getValues();
  if (dadosRe.length < 2) {
    Logger.log('reconstruirAbertos: aba Respostas vazia.');
    return { corrigidos: 0, abertos: 0, mensagem: 'Aba Respostas vazia.' };
  }

  // Bug#31 fix: mapa reverso de TIPOS_APONTAMENTO para lookup robusto
  // Normaliza strings para NFC evitando divergência de encoding UTF-8 entre
  // o código-fonte GAS e os valores armazenados pelo Sheets
  // (ex: "Í" precomposto U+00CD vs. "I" + combining accent U+0049+U+0301)
  const _tiposAberturaKeys   = ['ABERTURA', 'INICIO_RETRABALHO', 'INICIO_PARADA'];
  const _tiposFechamentoKeys = ['FECHAMENTO', 'TERMINO_RETRABALHO', 'TERMINO_PARADA'];
  // Cria conjuntos NFC-normalizados para comparação insensível a forma de normalização
  const tiposAberturaSet   = new Set(_tiposAberturaKeys.map(k => TIPOS_APONTAMENTO[k].normalize('NFC')));
  const tiposFechamentoSet = new Set(_tiposFechamentoKeys.map(k => TIPOS_APONTAMENTO[k].normalize('NFC')));
  // Helper: classifica um tipo de apontamento
  const ehAbertura   = (t) => tiposAberturaSet.has(String(t || '').normalize('NFC'));
  const ehFechamento = (t) => tiposFechamentoSet.has(String(t || '').normalize('NFC'));

  // Bug#fix3: Preservar o código original do operador de Abertos antes de reconstruir.
  // reconstruirAbertos lê Respostas col B (operadorNome = nome completo) e, para nomes
  // sem dígito inicial (ex: "ADILSON..."), normalizarCodigoOp devolve o nome em vez do
  // código, corrompendo Abertos col 0. Solução: ler o mapeamento nome→código de Abertos
  // antes de sobrescrevê-la.
  const nomeToCodigoOp = {};
  const abertoIdToLoteSeries = {}; // preserva loteSeries do Abertos antes de reconstruir
  const abertoIdToAlertaEnviado = {}; // preserva AlertaEnviadoEm — sem isso, todo item "aberto há muito tempo" reenviaria o alerta a cada 30min
  const dadosAbAntes = abaAb.getDataRange().getValues();
  for (let i = 1; i < dadosAbAntes.length; i++) {
    const codAntes      = String(dadosAbAntes[i][0]  || '').trim();
    const nomeAntes     = String(dadosAbAntes[i][10] || '').trim();
    const abertoIdAntes = String(dadosAbAntes[i][12] || '').trim();
    const loteSerAntes  = String(dadosAbAntes[i][11] || '').trim();
    const alertaAntes   = String(dadosAbAntes[i][COL_AB.ALERTA_ENVIADO_EM] || '').trim();
    if (codAntes && nomeAntes) nomeToCodigoOp[nomeAntes] = codAntes;
    if (abertoIdAntes && loteSerAntes) abertoIdToLoteSeries[abertoIdAntes] = loteSerAntes;
    if (abertoIdAntes && alertaAntes) abertoIdToAlertaEnviado[abertoIdAntes] = alertaAntes;
  }

  // Map: codigoOperador → dados da última abertura em aberto
  const abertosPorOp = {};
  // Fix#ParadaAninhada: paradas iniciadas DENTRO de uma ABERTURA/RETRABALHO (identificadas
  // pela coluna R = AbertoIdPai preenchida) não ocupam abertosPorOp — têm sua própria vaga
  // paralela, já que a produção/retrabalho pai continua "aberta" simultaneamente. Sem esta
  // separação, o código abaixo trataria a parada aninhada como uma segunda abertura genérica
  // do mesmo operador, disparando um falso positivo de anomaliasPokaYoke (a produção pai
  // pareceria "esquecida", quando na verdade está corretamente pausada, não abandonada).
  const paradasAninhadasPorOp = {};
  // Contadores por abertoId: quantas séries foram abertas e fechadas
  // Necessário para lotes parcialmente fechados: um FECHAMENTO de UMA série não deve
  // remover o operador de abertosPorOp — só remove quando TODAS as séries foram fechadas.
  const seriesAbertasPorId  = {}; // abertoId → count de linhas ABERTURA
  const seriesFechadasPorId = {}; // abertoId → count de linhas FECHAMENTO
  // Fix#PokaYokeEsquecido: registra quando encontramos uma abertura nova para um operador que
  // JÁ tinha uma abertura anterior sem fechamento correspondente. Sem esta detecção, o código
  // abaixo sobrescreveria abertosPorOp[operadorCod] silenciosamente — apagando para sempre o
  // rastro da abertura mais antiga (que nunca recebeu FECHAMENTO/TÉRMINO) e permitindo que o
  // operador continue abrindo indefinidamente sem nunca ser bloqueado por ela.
  const anomaliasPokaYoke = [];

  for (let i = 1; i < dadosRe.length; i++) {
    const row = dadosRe[i];
    if (!row[0] && !row[1]) continue; // linha vazia

    // Normaliza o carimbo para DD/MM/YYYY HH:mm:ss usando formatarCarimboGs().
    // ATENÇÃO: NÃO usar String(row[0]) diretamente — quando Sheets armazena a célula
    // como objeto Date, String(date) retorna "Tue Jun 09 2026 15:55:28 GMT-0" que
    // contém 'T' em "Tue", "Thu" e "GMT", fazendo a checagem includes('T') pular
    // TODOS os registros recentes (bug crítico que causava operadores sumirem de Abertos).
    const carimboBruto = formatarCarimboGs(row[0]);
    // Pula apenas: linhas sem carimbo válido ou datas legadas 1899 (artefato de célula vazia no Sheets)
    if (!carimboBruto || carimboBruto.includes('1899')) continue;

    const tipo        = String(row[2] || '').trim();
    const operadorRaw = String(row[1] || '').trim();

    // Bug#31 fix: extrai código numérico do operador via regex
    // Funciona com qualquer variante de traço (–, —, -) e formato de nome
    // Ex: "117 — RAFAEL..." → "117" | "000117" → "117" | "117" → "117"
    const codMatch    = operadorRaw.match(/^(\d+)/);
    const codPart     = codMatch ? codMatch[1] : operadorRaw.split(/\s*[—\-–]\s*/)[0].trim();
    const operadorCod = normalizarCodigoOp(codPart || operadorRaw);
    if (!operadorCod) continue;

    const abertoIdRe    = String(row[15] || '').trim();
    const abertoIdPaiRe = String(row[17] || '').trim(); // col R — Fix#ParadaAninhada

    // Fix#ParadaAninhada: linha de INICIO_PARADA com AbertoIdPai preenchido é uma parada
    // aninhada — não ocupa abertosPorOp (a produção/retrabalho pai continua aberta em
    // paralelo). Guarda numa vaga separada e pula o processamento genérico de abertura.
    if (ehAbertura(tipo) && abertoIdPaiRe) {
      // nrSeriePai: recupera do pai já processado nesta reconstrução (cronológica — o pai
      // sempre aparece antes) quando disponível; contexto informativo, não crítico.
      const paiAtual = abertosPorOp[operadorCod];
      const paiCasaComEsperado = paiAtual && paiAtual.abertoId === abertoIdPaiRe;
      paradasAninhadasPorOp[operadorCod] = {
        operador: operadorCod, operadorNome: operadorRaw,
        abertoIdPai: abertoIdPaiRe, abertoIdParada: abertoIdRe,
        tipoPai: paiCasaComEsperado ? paiAtual.tipo : '',
        tipoParada: String(row[10] || '').trim(), // col K — Tipo de parada
        carimbo: carimboBruto,
        nrSeriePai: paiCasaComEsperado ? paiAtual.nrSerie : '',
        codItemPai: String(row[4] || '').trim(),
      };
      continue;
    }

    if (ehAbertura(tipo)) {
      // Campo F: "22000073 | HAULER 10" | SÃO MARTINHO"
      const campoF     = String(row[5] || '');
      const partes     = campoF.split(' | ');
      const nrSerie    = (partes[0] || '').trim();
      const implemento = (partes[1] || '').trim();
      const cliente    = (partes[2] || '').trim();

      // Tenta recuperar loteSeries: primeiro da col Q de Respostas (gravada desde a correção),
      // depois do snapshot de Abertos (para registros anteriores à correção).
      let loteSeriesStr = String(row[16] || '').trim();
      if (!loteSeriesStr && abertoIdRe) loteSeriesStr = abertoIdToLoteSeries[abertoIdRe] || '';

      // Conta série aberta por abertoId (para decidir fechamento parcial vs. total)
      if (abertoIdRe) seriesAbertasPorId[abertoIdRe] = (seriesAbertasPorId[abertoIdRe] || 0) + 1;

      // Fix#PokaYokeEsquecido: se já há uma abertura pendente deste operador (nunca fechada),
      // NÃO sobrescreve — preserva a mais antiga como o que realmente bloqueia o operador
      // (é ela que está pendente há mais tempo) e registra a anomalia para investigação/
      // correção manual em vez de apagar o rastro silenciosamente.
      const pendenteAnterior = abertosPorOp[operadorCod];
      if (pendenteAnterior && pendenteAnterior.abertoId !== abertoIdRe) {
        anomaliasPokaYoke.push({
          operador: operadorCod, operadorNome: operadorRaw,
          tipoAnterior: pendenteAnterior.tipo, carimboAnterior: pendenteAnterior.carimbo, abertoIdAnterior: pendenteAnterior.abertoId,
          tipoNovo: tipo, carimboNovo: carimboBruto, abertoIdNovo: abertoIdRe,
        });
        continue; // mantém a mais antiga em abertosPorOp — não sobrescreve
      }

      abertosPorOp[operadorCod] = {
        operador:      operadorCod,
        implemento:    nrSerie,          // col 1: chave de busca (=nrSerie)
        tipo:          tipo,             // col 2
        operacao:      String(row[3] || '').trim(), // col 3
        carimbo:       carimboBruto,     // col 4
        codItem:       String(row[4] || '').trim(), // col 5
        qtdPlanejada:  row[14] || '',    // col 6 ← coluna O de Respostas
        nrSerie:       nrSerie,          // col 7
        implementoNome: implemento,      // col 8
        cliente:       cliente,          // col 9
        operadorNome:  operadorRaw,      // col 10
        loteSeries:    loteSeriesStr,    // col 11 — recuperado de Respostas col Q ou snapshot Abertos
        abertoId:      abertoIdRe,       // col 12 ← coluna P de Respostas
        isLote:        loteSeriesStr ? 'Sim' : 'Não', // col 13 — deriva do loteSeries sem heurística de texto
        alertaEnviadoEm: abertoIdToAlertaEnviado[abertoIdRe] || '', // col 14 — preservado do estado anterior
      };

    } else if (ehFechamento(tipo) && abertoIdPaiRe) {
      // Fix#ParadaAninhada: TERMINO_PARADA de uma parada aninhada — remove só da vaga
      // paralela. A ABERTURA/RETRABALHO pai (abertosPorOp) nunca foi tocada por esta parada
      // e continua intocada aqui também.
      delete paradasAninhadasPorOp[operadorCod];
    } else if (ehFechamento(tipo)) {
      // Conta série fechada por abertoId
      if (abertoIdRe) seriesFechadasPorId[abertoIdRe] = (seriesFechadasPorId[abertoIdRe] || 0) + 1;

      // Para lotes com fechamento parcial: só remove o operador de abertosPorOp quando
      // TODAS as séries do lote foram fechadas (fechadas >= abertas).
      // Para não-lote (série única): abertas=1, fechadas=1 → remove imediatamente.
      const totalAbertas  = seriesAbertasPorId[abertoIdRe] || 1;
      const totalFechadas = seriesFechadasPorId[abertoIdRe] || 0;
      if (totalFechadas >= totalAbertas) {
        delete abertosPorOp[operadorCod];
      }
    }
  }

  // Para lotes com fechamento parcial: filtrar loteSeries para manter apenas séries não fechadas.
  // Constrói mapa abertoId → Set de nrSerie já fechados (extraídos das linhas FECHAMENTO).
  const seriesFechadasPorIdSet = {}; // abertoId → Set<nrSerie>
  for (let i = 1; i < dadosRe.length; i++) {
    const row = dadosRe[i];
    if (!row[0] && !row[1]) continue;
    const carimboBruto = formatarCarimboGs(row[0]);
    if (!carimboBruto || carimboBruto.includes('1899')) continue;
    const tipo = String(row[2] || '').trim();
    if (!ehFechamento(tipo)) continue;
    const abertoIdRe = String(row[15] || '').trim();
    if (!abertoIdRe) continue;
    const nrSerieFech = String(row[5] || '').split(' | ')[0].trim();
    if (!nrSerieFech) continue;
    if (!seriesFechadasPorIdSet[abertoIdRe]) seriesFechadasPorIdSet[abertoIdRe] = new Set();
    seriesFechadasPorIdSet[abertoIdRe].add(nrSerieFech);
  }
  // Aplica filtro de séries restantes nos lotes parcialmente fechados
  for (const op of Object.values(abertosPorOp)) {
    if (!op.abertoId || !op.loteSeries) continue;
    try {
      const original = JSON.parse(op.loteSeries);
      const fechadasSet = seriesFechadasPorIdSet[op.abertoId];
      if (!fechadasSet || fechadasSet.size === 0) continue;
      const restantes = original.filter(s => !fechadasSet.has(String(s.nrSerie || '').trim()));
      if (restantes.length !== original.length) {
        op.loteSeries = JSON.stringify(restantes);
        // Atualiza nrSerie/implementoNome/cliente para a primeira série restante (chave de busca)
        if (restantes.length > 0) {
          op.nrSerie       = String(restantes[0].nrSerie    || '').trim();
          op.implemento    = op.nrSerie; // col 1 = nrSerie como chave
          op.implementoNome = String(restantes[0].implemento || '').trim();
          op.cliente       = String(restantes[0].cliente     || '').trim();
        }
      }
    } catch(e) { /* loteSeries inválido — ignora */ }
  }

  // Guarda quantos registros existiam antes
  const registrosAntes = Math.max(0, abaAb.getLastRow() - 1);

  // Monta linhas novas a serem escritas
  const abertos = Object.values(abertosPorOp);

  // Rede de segurança: item aberto além de uma jornada normal (>LIMIAR_HORAS_ABERTO_ALERTA)
  // vira alerta por e-mail — não depende do celular do operador pra nada, cobre o caso de um
  // fechamento que nunca chegou a sair do aparelho (ou o operador esqueceu mesmo). Cada item só
  // alerta uma vez (a.alertaEnviadoEm persiste na planilha entre execuções deste trigger de
  // 30min); quando o item fecha, some de abertosPorOp na próxima passada e a marca não precisa
  // de limpeza. Envio embrulhado em try/catch por item — uma falha de cota do MailApp não pode
  // abortar a checagem dos outros operadores.
  abertos.forEach(a => {
    if (a.alertaEnviadoEm) return; // já alertado — não repete
    const abertoMs = parseCarimboGsMs(a.carimbo);
    if (isNaN(abertoMs)) return;
    const horasAberto = (Date.now() - abertoMs) / 3600000;
    if (horasAberto < LIMIAR_HORAS_ABERTO_ALERTA) return;
    try {
      const html =
        '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">' +
        '<h3 style="color:#c0392b">⏰ Apontamento aberto há muito tempo — AGRICEF</h3>' +
        '<p>Um apontamento continua em aberto há mais de ' + LIMIAR_HORAS_ABERTO_ALERTA + ' horas — ' +
        'além do que uma jornada normal leva. Pode ser um fechamento que ficou preso no ' +
        'dispositivo do operador (fila offline) ou algo genuinamente esquecido. Vale confirmar ' +
        'com o operador.</p>' +
        '<table style="border-collapse:collapse;margin-top:8px">' +
        '<tr><td style="padding:4px 10px;font-weight:bold">Operador</td><td style="padding:4px 10px">' + (a.operadorNome || a.operador || '—') + '</td></tr>' +
        '<tr><td style="padding:4px 10px;font-weight:bold">Tipo</td><td style="padding:4px 10px">' + (a.tipo || '—') + '</td></tr>' +
        '<tr><td style="padding:4px 10px;font-weight:bold">Série/Implemento</td><td style="padding:4px 10px">' + (a.nrSerie || a.implemento || '—') + '</td></tr>' +
        '<tr><td style="padding:4px 10px;font-weight:bold">Código do item</td><td style="padding:4px 10px">' + (a.codItem || '—') + '</td></tr>' +
        '<tr><td style="padding:4px 10px;font-weight:bold">Aberto em</td><td style="padding:4px 10px">' + a.carimbo + '</td></tr>' +
        '<tr><td style="padding:4px 10px;font-weight:bold">Tempo aberto</td><td style="padding:4px 10px">' + horasAberto.toFixed(1) + 'h</td></tr>' +
        '</table>' +
        '</div>';
      MailApp.sendEmail({
        to:       EMAIL_ALERTA_FALHA,
        subject:  '⏰ AGRICEF | Apontamento aberto há ' + horasAberto.toFixed(0) + 'h — ' + (a.operadorNome || a.operador || ''),
        htmlBody: html,
      });
      a.alertaEnviadoEm = Utilities.formatDate(new Date(), 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
    } catch (alertErr) {
      Logger.log('reconstruirAbertos: falha ao enviar alerta de item aberto há muito tempo — ' + alertErr.message);
    }
  });

  const novasLinhas = abertos.map(a => [
    // Bug#fix3: restaurar código original se disponível (evita corromper col 0 com nome longo)
    nomeToCodigoOp[a.operadorNome] || a.operador,
    a.implemento,
    a.tipo,
    a.operacao,
    a.carimbo,
    a.codItem,
    a.qtdPlanejada,
    a.nrSerie,
    a.implementoNome,
    a.cliente,
    a.operadorNome,
    a.loteSeries,
    a.abertoId,
    a.isLote || 'Não',
    a.alertaEnviadoEm || '',
  ]);

  // Limpa Abertos de forma segura:
  // 1. Garante ao menos 1 linha extra para não deixar sheet completamente vazia
  // 2. Escreve as novas linhas (ou linha em branco se não houver abertos)
  // 3. Apaga o excedente
  const numNecessario = Math.max(novasLinhas.length, 1); // ao menos 1 linha abaixo do cabeçalho
  const ultimaLinha   = abaAb.getLastRow();

  // Se faltam linhas, adiciona linhas em branco para ter espaço
  if (ultimaLinha < numNecessario + 1) {
    const faltam = numNecessario + 1 - ultimaLinha;
    for (let k = 0; k < faltam; k++) abaAb.appendRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  }

  // Escreve as novas linhas (ou linha vazia na linha 2 se não houver abertos)
  if (novasLinhas.length > 0) {
    abaAb.getRange(2, 1, novasLinhas.length, 15).setValues(novasLinhas);
    // Força formato texto na coluna A (operador)
    abaAb.getRange(2, 1, novasLinhas.length, 1).setNumberFormat('@');
  } else {
    // Sem abertos: apenas limpa linha 2
    abaAb.getRange(2, 1, 1, 15).clearContent();
  }

  // Remove linhas excedentes (abaixo das novas linhas + 1 em branco obrigatória)
  const linhasUsadas = Math.max(novasLinhas.length, 1) + 1; // +1 = cabeçalho
  const totalAtual   = abaAb.getLastRow();
  if (totalAtual > linhasUsadas) {
    abaAb.deleteRows(linhasUsadas + 1, totalAtual - linhasUsadas);
  }

  // Fix#ParadaAninhada: reconstrói Paradas_Aninhadas do zero a partir do que sobrou em
  // paradasAninhadasPorOp (mesmo padrão de auto-cura já usado para Abertos acima).
  const abaParadasAnRec = garantirAbaParadasAninhadas(ss);
  const paradasAtivas = Object.values(paradasAninhadasPorOp);
  const linhasParadasAn = paradasAtivas.map(p => [
    nomeToCodigoOp[p.operadorNome] || p.operador,
    p.operadorNome,
    p.abertoIdPai,
    p.tipoPai,
    p.abertoIdParada,
    p.tipoParada,
    p.carimbo,
    p.nrSeriePai,
    p.codItemPai,
  ]);
  const totalParadasAnAntes = Math.max(0, abaParadasAnRec.getLastRow() - 1);
  if (totalParadasAnAntes > 0) abaParadasAnRec.deleteRows(2, totalParadasAnAntes);
  if (linhasParadasAn.length > 0) {
    abaParadasAnRec.getRange(2, 1, linhasParadasAn.length, 9).setValues(linhasParadasAn);
    abaParadasAnRec.getRange(2, 1, linhasParadasAn.length, 1).setNumberFormat('@');
  }

  SpreadsheetApp.flush();
  invalidarCacheAbertos(); // Opção A: Abertos foi reescrita do zero acima — invalida o cache curto

  const msg = 'reconstruirAbertos: ' + registrosAntes + ' antes → ' + abertos.length + ' depois.';
  Logger.log(msg);
  if (anomaliasPokaYoke.length > 0) {
    Logger.log('ALERTA reconstruirAbertos [PokaYokeEsquecido]: ' + anomaliasPokaYoke.length +
      ' operador(es) com abertura anterior nunca fechada, preservada em vez de sobrescrita: ' +
      JSON.stringify(anomaliasPokaYoke));
  }
  return {
    corrigidos: registrosAntes - abertos.length,
    abertos:    abertos.length,
    mensagem:   msg,
    anomaliasPokaYoke: anomaliasPokaYoke,
  };
  } catch (err) {
    // Sem isso, uma falha aqui é invisível: o trigger roda sozinho a cada 30min e uma exceção
    // não tratada simplesmente não faz nada — Abertos fica sem reconciliar até alguém notar
    // dados desencontrados manualmente. Re-lança para preservar o comportamento já esperado
    // por quem chama isso via HTTP (a action 'reconstruirAbertos' já trata o erro e responde).
    _alertarErroSistema('reconstruirAbertos', err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// TRIGGER — Reconciliação periódica da aba Abertos (a cada 30 min)
// Execute criarTriggerReconciliacaoAbertos() uma vez para ativar.
// ================================================================

function criarTriggerReconciliacaoAbertos() {
  // Remove triggers anteriores do mesmo handler (evita duplicação)
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'reconstruirAbertos')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('reconstruirAbertos')
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log('Trigger criado: reconstruirAbertos a cada 30 minutos.');
}

// ================================================================
// TRIGGER — Arquivamento diário de histórico (ver executarArquivamento, ~linha 2560)
// Execute criarTriggerArquivamento() uma vez para ativar. Só ativar depois de validar
// manualmente com previewArquivamento + algumas execuções manuais de executarArquivamento.
// ================================================================

function criarTriggerArquivamento() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'executarArquivamento')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('executarArquivamento')
    .timeBased()
    .atHour(3)
    .everyDays(1)
    .create();

  Logger.log('Trigger criado: executarArquivamento diariamente às 3h (GMT-3).');
}

// ================================================================
// NORMALIZAÇÃO DE CÓDIGOS DE OPERADOR — Execute sempre que necessário
// Remove zeros à esquerda de todos os registros (ex: "000130" → "130").
// Formato padrão: número simples sem padding — compatível com todos os
// sistemas de entrada que não adicionam zeros automaticamente.
// ================================================================
function normalizarCodigosOperador() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let totalCorrigidos = 0;

  // 1. Cadastro_Operadores — coluna A
  const abaOp = garantirAbaCadastro(ss, ABA_OPERADORES, ['Codigo', 'Nome', 'Ativo']);
  abaOp.getRange('A:A').setNumberFormat('@'); // força texto para preservar zeros
  const dadosOp = abaOp.getDataRange().getValues();
  for (let i = 1; i < dadosOp.length; i++) {
    const codAtual  = String(dadosOp[i][0] || '').trim();
    const codNorm   = normalizarCodigoOp(codAtual);
    if (codAtual !== codNorm && codNorm) {
      abaOp.getRange(i + 1, 1).setValue(codNorm);
      totalCorrigidos++;
      Logger.log('Operadores: linha ' + (i+1) + ': "' + codAtual + '" → "' + codNorm + '"');
    }
  }

  // 2. Aba Abertos — coluna A (Operador)
  const abaAb = ss.getSheetByName(ABA_ABERTOS);
  if (abaAb) {
    abaAb.getRange('A:A').setNumberFormat('@');
    const dadosAb = abaAb.getDataRange().getValues();
    for (let i = 1; i < dadosAb.length; i++) {
      const codAtual = String(dadosAb[i][0] || '').trim();
      const codNorm  = normalizarCodigoOp(codAtual);
      if (codAtual !== codNorm && codNorm) {
        abaAb.getRange(i + 1, 1).setValue(codNorm);
        totalCorrigidos++;
        Logger.log('Abertos: linha ' + (i+1) + ': "' + codAtual + '" → "' + codNorm + '"');
      }
    }
  }

  // 3. Aba Respostas — coluna B (NOME DO OPERADOR nos registros históricos)
  totalCorrigidos += normalizarRespostasColB();

  // 4. Invalida cache de cadastros para refletir as correções
  invalidarCacheCadastros();

  Logger.log('✅ Normalização concluída. ' + totalCorrigidos + ' código(s) corrigido(s).');
  return totalCorrigidos;
}

// ================================================================
// NORMALIZAÇÃO DA ABA RESPOSTAS — coluna B (NOME DO OPERADOR)
// Corrige entradas como "130 - NOME" ou "130 — NOME" para
// "000130 - NOME" / "000130 — NOME" nos registros históricos.
// Execute via: ?action=normalizarRespostas&key=AGF2026
// ================================================================
function normalizarRespostasColB() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) { Logger.log('Aba Respostas não encontrada.'); return 0; }
  const lastRow = aba.getLastRow();
  if (lastRow < 2) { Logger.log('Nenhum registro a normalizar.'); return 0; }

  // Leitura em lote — coluna B
  const range = aba.getRange(2, 2, lastRow - 1, 1);
  const colB  = range.getValues();
  let corrigidos = 0;

  for (let i = 0; i < colB.length; i++) {
    const val = String(colB[i][0] === null || colB[i][0] === undefined ? '' : colB[i][0]).trim();
    if (!val) continue;

    // Detecta separadores: " - " (hífen), " — " (travessão), " – " (meia-risca), ou só dígitos
    const mHifen = val.match(/^(\d+)\s*[-–]\s*(.*)/s);   // hífen ou en-dash
    const mTravo = val.match(/^(\d+)\s*—\s*(.*)/s);       // em-dash (correto)
    const mSo    = val.match(/^(\d+)$/);

    let code, nome;
    if      (mHifen) { code = mHifen[1]; nome = mHifen[2].trim(); }
    else if (mTravo) { code = mTravo[1]; nome = mTravo[2].trim(); }
    else if (mSo)    { code = mSo[1];    nome = ''; }
    else continue;

    // Padrão novo do sistema: "CODE — NOME" (travessão em-dash, sem zeros à esquerda)
    const codeNorm = normalizarCodigoOp(code);
    const novoVal  = nome ? (codeNorm + ' — ' + nome) : codeNorm;

    if (novoVal !== val) {
      colB[i][0] = novoVal;
      corrigidos++;
      Logger.log('Col B linha ' + (i + 2) + ': "' + val + '" → "' + novoVal + '"');
    }
  }

  if (corrigidos > 0) {
    range.setNumberFormat('@'); // força texto para preservar zeros se houver
    range.setValues(colB);
  }

  Logger.log('✅ Col B operadores: ' + corrigidos + ' registro(s) normalizado(s).');
  return corrigidos;
}

// ================================================================
// NORMALIZAR COLUNA A (DATAS) — converte tudo para dd/MM/yyyy HH:mm:ss
// Padrão do sistema novo (carimboBrowser).
// Trata: Date objects, YYYY/MM/DD texto, string inglesa "Thu May..."
// Execute via: ?action=normalizarDatas&key=AGF2026
//
// IMPORTANTE: usa a sequência correta para evitar que o Sheets
// reconverta strings de data de volta para Date objects:
//   1. setNumberFormat('@') na coluna INTEIRA
//   2. flush() para aplicar o formato antes de qualquer leitura/escrita
//   3. Converte TODOS os valores (não só os alterados) para string
//   4. setValues() com strings puras
//   5. setNumberFormat('@') novamente após gravar (double-lock)
// ================================================================
function normalizarDatasColA() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) { Logger.log('Aba Respostas não encontrada.'); return 0; }
  const lastRow = aba.getLastRow();
  if (lastRow < 2) { Logger.log('Nenhum registro a normalizar.'); return 0; }

  const range = aba.getRange(2, 1, lastRow - 1, 1);

  // PASSO 1: forçar formato texto na coluna ANTES de ler os valores
  // Sem isso, o Sheets reconverte strings de data para Date objects ao gravar.
  range.setNumberFormat('@');
  SpreadsheetApp.flush(); // aplica imediatamente

  const colA  = range.getValues();
  let corrigidos = 0;

  const MESES_EN = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};

  for (let i = 0; i < colA.length; i++) {
    const val = colA[i][0];
    if (val === null || val === undefined || val === '') continue;

    let nova = null;

    if (val instanceof Date) {
      // Date object (Form response ou Sheets auto-convertido) → texto padrão
      nova = Utilities.formatDate(val, 'GMT-3', 'dd/MM/yyyy HH:mm:ss');

    } else {
      const s = String(val).trim();
      if (!s) continue;

      // Já está em dd/MM/yyyy HH:mm:ss — padrão correto
      // Mesmo assim gravar de volta como string para consolidar o formato texto
      if (/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/.test(s)) {
        colA[i][0] = s; // garante string pura, não Date
        continue;
      }

      // Já está em dd/MM/yyyy (sem hora) — complementa com 00:00:00
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        nova = s + ' 00:00:00';
      }

      // yyyy/MM/dd HH:mm:ss  →  dd/MM/yyyy HH:mm:ss
      if (!nova) {
        const mISO = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
        if (mISO) nova = mISO[3] + '/' + mISO[2] + '/' + mISO[1] + ' ' + mISO[4];
      }

      // yyyy/MM/dd HH:mm (sem segundos)
      if (!nova) {
        const mISOt = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2})$/);
        if (mISOt) nova = mISOt[3] + '/' + mISOt[2] + '/' + mISOt[1] + ' ' + mISOt[4] + ':00';
      }

      // yyyy/MM/dd (sem hora)
      if (!nova) {
        const mISOd = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
        if (mISOd) nova = mISOd[3] + '/' + mISOd[2] + '/' + mISOd[1] + ' 00:00:00';
      }

      // dd/MM/yyyy HH:mm (sem segundos) — complementa
      if (!nova) {
        const mPT = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})$/);
        if (mPT) nova = mPT[1] + '/' + mPT[2] + '/' + mPT[3] + ' ' + mPT[4] + ':00';
      }

      // String inglesa "Thu May 14 2026 12:15:07 GMT..."
      if (!nova) {
        const mEng = s.match(/\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (mEng) {
          const mes = MESES_EN[mEng[1]];
          if (mes) {
            nova = String(mEng[2]).padStart(2,'0') + '/' + String(mes).padStart(2,'0') + '/' + mEng[3] +
                   ' ' + mEng[4] + ':' + mEng[5] + ':' + mEng[6];
          }
        }
      }
    }

    if (nova) {
      colA[i][0] = nova;
      corrigidos++;
    }
  }

  // PASSO 2: gravar todos os valores como strings
  range.setValues(colA);

  // PASSO 3: forçar formato texto novamente após gravar (double-lock)
  range.setNumberFormat('@');
  SpreadsheetApp.flush();

  Logger.log('✅ Col A datas: ' + corrigidos + ' registro(s) normalizado(s).');
  return corrigidos;
}

// ================================================================
// NORMALIZAR TUDO — roda datas (col A) + operadores (col B) de uma vez
// Execute via: ?action=normalizarTodos&key=AGF2026
// ================================================================
function normalizarTodosDados() {
  const datas     = normalizarDatasColA();
  const operadores = normalizarRespostasColB();
  return { datas, operadores, total: datas + operadores };
}

function verificarEstrutura() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) { Logger.log('Aba não encontrada!'); return; }
  const cab = aba.getRange(1,1,1,aba.getLastColumn()).getValues()[0];
  cab.forEach((c,i) => Logger.log(String.fromCharCode(65+i) + ': ' + c));
}

function testeGravar() {
  const now = new Date();
  const p2  = n => String(n).padStart(2,'0');
  const ts  = p2(now.getDate())+'/'+p2(now.getMonth()+1)+'/'+now.getFullYear()+' '+p2(now.getHours())+':'+p2(now.getMinutes())+':'+p2(now.getSeconds());
  const payload = {
    timestamp: ts, hora: p2(now.getHours())+':'+p2(now.getMinutes()),
    operador:'004077', operadorNome:'004077 - PAULO JOAQUIM DE SANTANA',
    nrSerie:'22000074', implemento:'HAULER 10"', cliente:'ATVOS',
    tipoApontamento:'ABERTURA', operacao:'0010',
    codItem:'509419', quantidade:'', qtdPlanejada:'20', obs1:'Teste v4',
    setup:'', obs2:'', retrabalho:'', numRNC:'', opRetrabalho:'', parada:'', lote:'',
  };
  Logger.log(gravarApontamento(payload).getContent());
}

// Execute esta função UMA VEZ manualmente pelo Editor (não via URL) para que o
// Google solicite a tela de autorização do escopo "Conectar-se a um serviço
// externo" (UrlFetchApp para fora do Google) — necessário para a IA funcionar.
function autorizarAcessoExternoIA() {
  const resp = UrlFetchApp.fetch('https://api.anthropic.com', { muteHttpExceptions: true });
  Logger.log('Autorização concedida. HTTP status: ' + resp.getResponseCode());
}

// ================================================================
// ANALISTA DE PRODUÇÃO VIRTUAL (IA) — v1.0
//
// Gera uma análise interpretativa (Claude API) a partir dos MESMOS dados já
// calculados pelos relatórios diário/semanal (KPIs, tendência, top operadores,
// backlog, alertas e recomendações de regras fixas). Não substitui essas
// regras — adiciona uma camada de interpretação por cima delas.
//
// Configuração (executar UMA VEZ pelo Editor do Apps Script):
//   configurarApiKeyAnthropic("sk-ant-...")
//
// Se a chamada à IA falhar por qualquer motivo (key ausente, rede, rate
// limit), gerarAnaliseIA() retorna null e quem chamou (enviarRelatorioSemanal/
// enviarRelatorioDiario) segue normalmente — a análise de IA NUNCA impede o
// relatório de regras fixas de ser calculado e enviado.
// ================================================================

function configurarApiKeyAnthropic(key) {
  if (!key || String(key).trim() === '') throw new Error('Informe a API key da Anthropic como parâmetro.');
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', String(key).trim());
  Logger.log('✅ API key da Anthropic configurada.');
}

function chamarClaudeAPI(promptTexto) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('API key da Anthropic não configurada. Execute configurarApiKeyAnthropic("sua-key") uma vez pelo editor.');
  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: promptTexto }],
    }),
    muteHttpExceptions: true,
  });
  const codigo = resp.getResponseCode();
  const corpo  = resp.getContentText();
  if (codigo !== 200) {
    throw new Error('Erro Claude API (HTTP ' + codigo + '): ' + corpo.substring(0, 300));
  }
  const json = JSON.parse(corpo);
  if (!json.content || !json.content[0] || !json.content[0].text) {
    throw new Error('Resposta inesperada da Claude API: ' + corpo.substring(0, 300));
  }
  return json.content[0].text;
}

// Monta o prompt a partir do MESMO objeto `rel` retornado por
// _rsMontarRelatorio() (tipo='semanal') ou _rdMontarRelatorio() (tipo='diario').
// Defensivo: cada seção só entra no resumo se o campo existir nos dados.
function montarPromptAnalise(rel, tipo) {
  const fmtData = function(d) { return Utilities.formatDate(d, 'GMT-3', 'dd/MM/yyyy'); };
  let resumo = '';

  if (tipo === 'semanal') {
    const kpiAtual = rel.kpiAtual || {}, kpiAnterior = rel.kpiAnterior || {};
    resumo += 'KPIs da semana atual: ' + (kpiAtual.throughput || 0) + ' entregas, ' + (kpiAtual.entradas || 0)
      + ' novas entradas, lead time médio ' + (kpiAtual.leadMedio || 0).toFixed(1) + 'h.\n';
    resumo += 'KPIs da semana anterior: ' + (kpiAnterior.throughput || 0) + ' entregas, ' + (kpiAnterior.entradas || 0)
      + ' entradas, lead time médio ' + (kpiAnterior.leadMedio || 0).toFixed(1) + 'h.\n\n';

    if (rel.trend && rel.trend.length) {
      resumo += 'Tendência das últimas 4 semanas (entradas / saídas / lead time):\n';
      rel.trend.forEach(function(t) {
        resumo += '- semana de ' + fmtData(t.ini) + ': ' + t.entradas + ' entradas, ' + t.throughput + ' saídas, lead time ' + t.leadMedio.toFixed(1) + 'h\n';
      });
      resumo += '\n';
    }
    if (rel.topOperadores && rel.topOperadores.length) {
      resumo += 'Top operadores (mais fechamentos na semana):\n';
      rel.topOperadores.forEach(function(e) { resumo += '- ' + e[0] + ': ' + e[1] + ' fechamentos\n'; });
      resumo += '\n';
    }
    if (rel.topOperacoes && rel.topOperacoes.length) {
      resumo += 'Top operações (mais saídas na semana):\n';
      rel.topOperacoes.forEach(function(e) { resumo += '- ' + e[0] + ': ' + e[1] + '\n'; });
      resumo += '\n';
    }
    const backlog = rel.backlog || [];
    resumo += 'Backlog atual: ' + backlog.length + ' ordens em aberto.\n';
    if (backlog.length > 0) {
      resumo += 'Ordens mais antigas em aberto (até 10):\n';
      backlog.slice(0, 10).forEach(function(o) {
        const dias = Math.floor((rel.agora - o.ts) / 86400000);
        resumo += '- ' + (o.func || '(sem nome)') + ' | operação: ' + (o.op || '—') + ' | item: ' + (o.item || '—') + ' | aberta há ' + dias + ' dia(s)\n';
      });
    }
    resumo += '\nAlertas já identificados pelo sistema (regras fixas):\n';
    (rel.alertas || []).forEach(function(a) { resumo += '- [' + a.nivel + '] ' + a.msg + '\n'; });
    resumo += '\nRecomendações já geradas pelo sistema (regras fixas):\n';
    (rel.recos || []).forEach(function(r) { resumo += '- ' + r + '\n'; });
  } else {
    // diario
    resumo += 'Referência: ' + (rel.refDiaLabel || 'hoje') + '.\n';
    const backlog = rel.backlog || [];
    resumo += 'Backlog atual: ' + backlog.length + ' ordens em aberto.\n\n';
    if (rel.topBacklogOp && rel.topBacklogOp.length) {
      resumo += 'Operadores com mais ordens em aberto:\n';
      rel.topBacklogOp.forEach(function(e) { resumo += '- ' + e[0] + ': ' + e[1] + ' ordem(ns)\n'; });
      resumo += '\n';
    }
    if (rel.ordensAntigas && rel.ordensAntigas.length) {
      resumo += 'Ordens mais antigas em aberto:\n';
      rel.ordensAntigas.slice(0, 8).forEach(function(o) {
        resumo += '- ' + (o.func || '(sem nome)') + ' | operação: ' + (o.op || '—') + ' | item: ' + (o.item || '—') + '\n';
      });
      resumo += '\n';
    }
    if (rel.topGargalos && rel.topGargalos.length) {
      resumo += 'Operações com mais backlog (gargalos):\n';
      rel.topGargalos.forEach(function(e) { resumo += '- ' + e[0] + ': ' + e[1] + '\n'; });
      resumo += '\n';
    }
    if (rel.topSeries && rel.topSeries.length) {
      resumo += 'Séries com mais backlog:\n';
      rel.topSeries.forEach(function(e) { resumo += '- ' + e[0] + ': ' + e[1] + '\n'; });
      resumo += '\n';
    }
    if (rel.semAtividade && rel.semAtividade.length) {
      resumo += 'Operadores sem atividade recente: ' + rel.semAtividade.join(', ') + '\n\n';
    }
    if (rel.retrAbertos && rel.retrAbertos.length) {
      resumo += 'Retrabalhos em aberto: ' + rel.retrAbertos.length + '\n\n';
    }
    resumo += 'Alertas já identificados pelo sistema (regras fixas):\n';
    (rel.alertas || []).forEach(function(a) { resumo += '- [' + a.nivel + '] ' + a.msg + '\n'; });
    resumo += '\nAções já recomendadas pelo sistema (regras fixas):\n';
    (rel.acoes || []).forEach(function(a) { resumo += '- ' + a + '\n'; });
  }

  return 'Você é um analista de produção virtual de uma fábrica de implementos agrícolas (AGRICEF). '
    + 'Você recebe abaixo os dados JÁ CALCULADOS de um relatório de produção (' + (tipo === 'semanal' ? 'semanal' : 'diário') + '). '
    + 'Sua tarefa é interpretar esses dados como um analista experiente explicaria para a gestão da fábrica — não repita os números brutos, explique o que eles significam.\n\n'
    + 'Escreva uma análise curta e direta (parágrafos corridos separados por linha em branco, sem markdown, sem listas com marcadores) cobrindo:\n'
    + '1. Resumo do desempenho no período\n'
    + '2. Quais colaboradores ou processos merecem atenção (positiva ou negativa) e por quê\n'
    + '3. Causas prováveis dos desvios observados (com base apenas nos dados fornecidos — não invente números que não estão aqui)\n'
    + '4. Onde estão os gargalos operacionais\n'
    + '5. Ações concretas que a gestão pode tomar\n'
    + '6. Se fizer alguma projeção de tendência, deixe explícito que é uma extrapolação dos dados recentes, não uma previsão estatística validada.\n\n'
    + 'Seja direto, objetivo e específico — cite nomes/operações/números quando relevante. Máximo de 350 palavras.\n\n'
    + '=== DADOS DO RELATÓRIO ===\n' + resumo;
}

function _salvarAnaliseIA(tipo, texto) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba   = garantirAbaAnaliseIA(ss);
  const dados = aba.getDataRange().getValues();
  const agora = Utilities.formatDate(new Date(), 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
  let linhaIdx = -1;
  for (let i = 1; i < dados.length; i++) {
    if (String(dados[i][1] || '').trim() === tipo) { linhaIdx = i; break; }
  }
  if (linhaIdx === -1) {
    aba.appendRow([agora, tipo, texto]);
  } else {
    aba.getRange(linhaIdx + 1, 1, 1, 3).setValues([[agora, tipo, texto]]);
  }
}

// Orquestra: monta prompt → chama API → salva. Nunca lança erro — quem chamar
// recebe null em caso de falha e deve seguir o fluxo normal sem a análise.
function gerarAnaliseIA(rel, tipo) {
  try {
    const prompt = montarPromptAnalise(rel, tipo);
    const texto  = chamarClaudeAPI(prompt);
    _salvarAnaliseIA(tipo, texto);
    return texto;
  } catch (err) {
    Logger.log('⚠️ Falha ao gerar análise de IA (' + tipo + '): ' + err.message);
    return null;
  }
}

// Endpoint: ?action=getAnaliseIA — retorna a última análise diária e semanal salvas.
function getAnaliseIAAction() {
  try {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const aba = ss.getSheetByName(ABA_ANALISES_IA);
    const resultado = { diario: null, semanal: null };
    if (aba) {
      const dados = aba.getDataRange().getValues();
      for (let i = 1; i < dados.length; i++) {
        const tipoLinha = String(dados[i][1] || '').trim();
        if (tipoLinha === 'diario' || tipoLinha === 'semanal') {
          const dataRaw = dados[i][0];
          // O Sheets pode autoconverter a string de data em objeto Date nativo na célula —
          // formata corretamente em ambos os casos para nunca expor o .toString() verboso do JS.
          const dataFmt = (dataRaw instanceof Date)
            ? Utilities.formatDate(dataRaw, 'GMT-3', 'dd/MM/yyyy HH:mm:ss')
            : String(dataRaw || '');
          resultado[tipoLinha] = { data: dataFmt, texto: String(dados[i][2] || '') };
        }
      }
    }
    return jsonResponse(resultado);
  } catch (err) {
    return jsonResponse({ diario: null, semanal: null, erro: err.message });
  }
}

// ================================================================
// RELATÓRIO SEMANAL AUTOMATIZADO — v1.0
//
// Envio: toda segunda-feira às 07h00 (horário de Brasília)
// Para ativar o envio automático, abra o Editor do Apps Script
// e execute UMA VEZ a função: criarTriggerRelatorioSemanal()
//
// Para testar manualmente: execute enviarRelatorioSemanal()
// ================================================================

const EMAIL_RELATORIO    = 'guilherme.souza@agricef.com.br,luciano.oliveira@agricef.com.br,cerri@agricef.com.br';
const EMAIL_ALERTA_FALHA = 'guilherme.souza@agricef.com.br';
const DIAS_ALERTA_ATRASO = 3; // ordens abertas há mais que isso → alerta vermelho
// Rede de segurança de reconstruirAbertos — bem mais rápido que o dígest diário acima (que só
// roda 1x/dia às 7h e só alerta depois de DIAS_ALERTA_ATRASO=3 dias). Jornadas normais fecham
// em 9-11h pelos dados reais já observados; 12h dá margem sem soar falso positivo num job
// legítimo de um dia só.
const LIMIAR_HORAS_ABERTO_ALERTA = 12;

// ---------------------------------------------------------------
// PONTO DE ENTRADA — chamado pelo trigger ou manualmente
// ---------------------------------------------------------------
function enviarRelatorioSemanal() {
  try {
    const rel = _rsMontarRelatorio();
    rel.analiseIA = gerarAnaliseIA(rel, 'semanal'); // null em caso de falha — não bloqueia o envio
    _rsEnviarEmail(rel);
    Logger.log('✅ Relatório semanal enviado para ' + EMAIL_RELATORIO);
  } catch (err) {
    Logger.log('❌ Erro no relatório: ' + err.message + '\n' + err.stack);
    throw err;
  }
}

// ---------------------------------------------------------------
// CONFIGURAR TRIGGER SEMANAL — executar UMA VEZ pelo Editor
// ---------------------------------------------------------------
function criarTriggerRelatorioSemanal() {
  // Remove triggers duplicados da mesma função
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'enviarRelatorioSemanal')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('enviarRelatorioSemanal')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();

  Logger.log('✅ Trigger criado: toda segunda-feira às 07h (GMT-3).');
}

// ---------------------------------------------------------------
// MONTAR OBJETO DO RELATÓRIO — lê planilha e computa todos os KPIs
// ---------------------------------------------------------------
function _rsMontarRelatorio() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) throw new Error('Aba "' + ABA_RESPOSTAS + '" não encontrada.');

  const dados = aba.getDataRange().getValues();
  const agora = new Date();

  // Início da semana atual (segunda-feira 00h00)
  const dow = agora.getDay(); // 0=dom, 1=seg ...
  const diasAteSeg = (dow === 0) ? 6 : dow - 1;
  const seg = new Date(agora);
  seg.setDate(agora.getDate() - diasAteSeg);
  seg.setHours(0, 0, 0, 0);

  const segAnterior = new Date(seg);
  segAnterior.setDate(seg.getDate() - 7);

  // ----- Parse de todas as linhas relevantes -----
  const linhas = [];
  for (let i = 1; i < dados.length; i++) {
    const r = dados[i];
    if (!r[0] || !r[2]) continue;
    const ts = _rsParseData(r[0]);
    if (!ts) continue;
    const tipoRaw = String(r[2]).toUpperCase();
    let tipo = null;
    if (tipoRaw.includes('ABERTURA') && !tipoRaw.includes('RETRABALHO')) tipo = 'ABERTURA';
    else if (tipoRaw.includes('FECHAMENTO')) tipo = 'FECHAMENTO';
    else continue; // ignora paradas e retrabalhos neste contexto
    const campoF = String(r[5] || '');
    const pts    = campoF.split('|').map(x => x.trim());
    const funcRaw = String(r[1] || '').trim();
    linhas.push({
      ts,
      tipo,
      func:     funcRaw,
      funcCod:  _rdCodigoOp(funcRaw), // código normalizado para pareamento
      op:     String(r[3] || '').trim(),
      item:   String(r[4] || '').trim(),
      serie:  pts[0] || '',
      impl:   pts[1] || '',
      client: pts[2] || '',
      qty:    Number(r[6])  || 0,
      qtdPl:  Number(r[14]) || 0,
    });
  }

  // ----- Algoritmo de pareamento ABERTURA ↔ FECHAMENTO -----
  const aberturas = linhas
    .filter(r => r.tipo === 'ABERTURA')
    .map(r => ({ ...r, _used: false, _fechTs: null, _leadMs: 0 }));

  linhas
    .filter(r => r.tipo === 'FECHAMENTO')
    .forEach(fech => {
      let melhor = null, melhorScore = -1;
      for (let i = 0; i < aberturas.length; i++) {
        const a = aberturas[i];
        // funcCod tolera hífen vs em-dash e variações de zeros
        if (a._used || a.funcCod !== fech.funcCod || a.ts > fech.ts) continue;
        let score = 1;
        if (a.op    === fech.op)    score += 4;
        if (a.serie === fech.serie) score += 2;
        if (a.item  === fech.item)  score += 1;
        // Empate: prefere a ABERTURA mais recente (mais próxima do FECHAMENTO)
        if (score > melhorScore || (score === melhorScore && melhor !== null && a.ts > aberturas[melhor].ts)) {
          melhorScore = score; melhor = i;
        }
      }
      if (melhor !== null) {
        aberturas[melhor]._used   = true;
        aberturas[melhor]._fechTs = fech.ts;
        aberturas[melhor]._leadMs = fech.ts - aberturas[melhor].ts;
        aberturas[melhor]._fechOp = fech.op;
      }
    });

  const pares   = aberturas.filter(a => a._used);
  const backlog = aberturas.filter(a => !a._used).sort((x, y) => x.ts - y.ts);

  // ----- KPIs semana atual e anterior -----
  const kpiAtual    = _rsKpiSemana(pares, seg,         new Date(seg.getTime()          + 7 * 86400000));
  const kpiAnterior = _rsKpiSemana(pares, segAnterior, new Date(segAnterior.getTime()  + 7 * 86400000));

  // ----- Tendência 4 semanas -----
  const trend = [];
  for (let w = 3; w >= 0; w--) {
    const ini = new Date(seg); ini.setDate(seg.getDate() - w * 7);
    const fim = new Date(ini); fim.setDate(ini.getDate() + 7);
    trend.push({ ini, fim, ..._rsKpiSemana(pares, ini, fim) });
  }

  // ----- Top operadores (semana atual) — agrupa por código normalizado -----
  const contOp = {};
  pares.filter(p => p._fechTs >= seg).forEach(p => {
    const cod  = p.funcCod || p.func;
    const nome = _rdNomeOp(p.func);
    if (!contOp[cod]) contOp[cod] = { nome, count: 0 };
    contOp[cod].count++;
  });
  const topOperadores = Object.values(contOp)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(e => [e.nome, e.count]);

  // ----- Top operações (semana atual) -----
  const contOperacao = {};
  pares.filter(p => p._fechTs >= seg).forEach(p => {
    const op = (p._fechOp || p.op || '(sem operação)');
    contOperacao[op] = (contOperacao[op] || 0) + 1;
  });
  const topOperacoes = Object.entries(contOperacao).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // ----- Alertas e recomendações -----
  const alertas = _rsAlertas(backlog, kpiAtual, kpiAnterior, agora);
  const recos   = _rsRecomendacoes(backlog, kpiAtual, kpiAnterior, topOperadores, topOperacoes, agora);

  return {
    agora, seg, segAnterior,
    kpiAtual, kpiAnterior,
    trend, topOperadores, topOperacoes,
    backlog, alertas, recos,
  };
}

// ---------------------------------------------------------------
// KPIs DE UM PERÍODO
// ---------------------------------------------------------------
function _rsKpiSemana(pares, inicio, fim) {
  const entregas = pares.filter(p => p._fechTs >= inicio && p._fechTs < fim);
  const entradas = pares.filter(p => p.ts      >= inicio && p.ts      < fim);

  const leadTimes = entregas
    .map(p => p._leadMs / 3600000)
    .filter(h => h > 0 && h < 24 * 30); // sanidade: entre 0 e 30 dias

  const leadMedio = leadTimes.length
    ? leadTimes.reduce((s, v) => s + v, 0) / leadTimes.length
    : 0;

  return {
    throughput: entregas.length,
    entradas:   entradas.length,
    leadMedio,  // em horas
  };
}

// ---------------------------------------------------------------
// ALERTAS INTELIGENTES
// ---------------------------------------------------------------
function _rsAlertas(backlog, kpiAtual, kpiAnterior, agora) {
  const lista = [];

  // 1. Volume de backlog
  if (backlog.length >= 15) {
    lista.push({ nivel: 'CRITICO', msg: 'Backlog crítico: ' + backlog.length + ' ordens em aberto. Verifique gargalos e redistribua a carga imediatamente.' });
  } else if (backlog.length >= 8) {
    lista.push({ nivel: 'ATENCAO', msg: 'Backlog elevado: ' + backlog.length + ' ordens em aberto. Monitorar evolução ao longo da semana.' });
  }

  // 2. Ordens antigas sem fechamento
  const limiteMs = DIAS_ALERTA_ATRASO * 86400 * 1000;
  const antigas  = backlog.filter(o => (agora - o.ts) > limiteMs);
  if (antigas.length > 0) {
    const series = [...new Set(antigas.map(o => o.serie).filter(Boolean))].slice(0, 3).join(', ');
    lista.push({
      nivel: 'ATENCAO',
      msg: antigas.length + ' ordem(ns) aberta(s) há mais de ' + DIAS_ALERTA_ATRASO + ' dias sem fechamento.'
           + (series ? ' Séries: ' + series + '.' : ''),
    });
  }

  // 3. Queda de throughput ≥ 25%
  if (kpiAnterior.throughput > 0) {
    const pct = Math.round(((kpiAtual.throughput - kpiAnterior.throughput) / kpiAnterior.throughput) * 100);
    if (pct <= -25) {
      lista.push({ nivel: 'ATENCAO', msg: 'Queda de ' + Math.abs(pct) + '% no throughput vs. semana anterior (' + kpiAnterior.throughput + ' → ' + kpiAtual.throughput + ' entregas).' });
    }
  }

  // 4. Semana sem nenhum fechamento
  if (kpiAtual.throughput === 0) {
    lista.push({ nivel: 'CRITICO', msg: 'Nenhum fechamento registrado nesta semana. Verifique se os operadores estão utilizando o sistema.' });
  }

  // 5. Lead time alto (> 8h)
  if (kpiAtual.leadMedio > 8) {
    lista.push({ nivel: 'ATENCAO', msg: 'Lead time médio elevado: ' + kpiAtual.leadMedio.toFixed(1) + 'h. Pode indicar espera de material, retrabalho ou operações subdimensionadas.' });
  }

  // 6. Entradas muito acima de saídas
  if (kpiAtual.entradas > 0 && kpiAtual.throughput > 0 && kpiAtual.entradas > kpiAtual.throughput * 1.5) {
    lista.push({ nivel: 'ATENCAO', msg: 'Entradas (' + kpiAtual.entradas + ') superam entregas (' + kpiAtual.throughput + ') em ' + Math.round(((kpiAtual.entradas / kpiAtual.throughput) - 1) * 100) + '%. O backlog tende a crescer.' });
  }

  return lista;
}

// ---------------------------------------------------------------
// RECOMENDAÇÕES CONTEXTUAIS
// ---------------------------------------------------------------
function _rsRecomendacoes(backlog, kpiAtual, kpiAnterior, topOp, topOperacoes, agora) {
  const lista = [];
  const limiteMs = DIAS_ALERTA_ATRASO * 86400 * 1000;
  const antigas  = backlog.filter(o => (agora - o.ts) > limiteMs);

  if (antigas.length > 0) {
    lista.push('⚡ Priorizar o fechamento das ' + antigas.length + ' ordem(ns) com mais de ' + DIAS_ALERTA_ATRASO + ' dias em aberto. Conversar diretamente com os operadores envolvidos para identificar impedimentos.');
  }

  if (kpiAnterior.throughput > 0 && kpiAtual.throughput < kpiAnterior.throughput) {
    lista.push('📉 Throughput abaixo do período anterior. Revisar distribuição de tarefas, checar se houve paradas não registradas e avaliar se há recursos disponíveis para reforço.');
  }

  if (backlog.length > 5) {
    const opBacklog = {};
    backlog.forEach(o => { const k = o.op || ''; if (k) opBacklog[k] = (opBacklog[k] || 0) + 1; });
    const gargalos = Object.entries(opBacklog).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]).join(', ');
    if (gargalos) {
      lista.push('🔍 Operações com maior concentração no backlog: ' + gargalos + '. Avaliar reforço de equipe ou resequenciamento nessas etapas.');
    }
  }

  if (kpiAtual.leadMedio > 6) {
    lista.push('⏱ Lead time médio de ' + kpiAtual.leadMedio.toFixed(1) + 'h. Investigar se operações podem ser subdivididas, paralelizadas ou se há tempos de espera desnecessários no processo.');
  }

  if (kpiAtual.entradas > kpiAtual.throughput * 1.3 && kpiAtual.entradas > 0) {
    lista.push('📥 Volume de entradas supera entregas em mais de 30%. Considerar priorização de carteira ou alocação de capacidade extra para evitar crescimento contínuo do backlog.');
  }

  if (topOp.length > 0) {
    lista.push('🏆 Destaque da semana: ' + topOp[0][0] + ' com ' + topOp[0][1] + ' fechamentos. Identificar boas práticas deste operador e replicar para a equipe.');
  }

  if (lista.length === 0) {
    lista.push('✅ Indicadores dentro do esperado. Manter cadência de apontamentos e foco na antecipação de demandas para as próximas semanas.');
  }

  return lista;
}

// ---------------------------------------------------------------
// GERAÇÃO DO HTML DO EMAIL
// ---------------------------------------------------------------
function _rsGerarHtml(rel) {
  const { agora, seg, kpiAtual, kpiAnterior, trend, topOperadores, topOperacoes, backlog, alertas, recos, analiseIA } = rel;

  // ----- HTML: Análise de IA (opcional — só aparece se gerarAnaliseIA teve sucesso) -----
  let htmlAnaliseIA = '';
  if (analiseIA) {
    const paragrafos = String(analiseIA).split(/\n+/).filter(function(p) { return p.trim() !== ''; });
    const corpoIA = paragrafos.map(function(p) {
      return '<p style="margin:0 0 10px;font-size:13px;color:#e6edf3;line-height:1.6;">' + p + '</p>';
    }).join('');
    htmlAnaliseIA = '<tr><td style="background:#111722;padding:4px 28px 16px;">'
      + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">🤖 Análise do Analista de Produção Virtual</div>'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;"><tr><td style="padding:14px 16px;">'
      + corpoIA
      + '</td></tr></table></td></tr>';
  }

  const fmt  = d => Utilities.formatDate(d, 'GMT-3', 'dd/MM/yyyy');
  const fmtH = h => h < 1 ? Math.round(h * 60) + 'min' : h.toFixed(1) + 'h';

  const fimSem     = new Date(seg.getTime() + 6 * 86400000);
  const semanaStr  = fmt(seg) + ' – ' + fmt(fimSem);
  const dataEnvio  = Utilities.formatDate(agora, 'GMT-3', "dd/MM/yyyy 'às' HH:mm");

  // Delta throughput
  const deltaTP    = kpiAnterior.throughput > 0
    ? Math.round(((kpiAtual.throughput - kpiAnterior.throughput) / kpiAnterior.throughput) * 100)
    : null;
  const deltaTPStr   = deltaTP === null ? '—' : (deltaTP >= 0 ? '▲ ' + deltaTP + '%' : '▼ ' + Math.abs(deltaTP) + '%');
  const deltaTPColor = deltaTP === null ? '#8b949e' : (deltaTP >= 0 ? '#4ade80' : '#f87171');

  // Cor do KPI backlog
  const corBacklog = backlog.length >= 15 ? '#f87171' : backlog.length >= 8 ? '#fb923c' : '#4ade80';

  // ----- HTML: Alertas -----
  let htmlAlertas = '';
  if (alertas.length === 0) {
    htmlAlertas = '<tr><td style="padding:12px 16px;color:#4ade80;font-size:14px;">✅ Nenhum alerta crítico esta semana.</td></tr>';
  } else {
    alertas.forEach(function(a) {
      var cor = a.nivel === 'CRITICO' ? '#f87171' : '#fb923c';
      var ico = a.nivel === 'CRITICO' ? '🔴' : '🟡';
      htmlAlertas += '<tr><td style="padding:9px 14px 9px 16px;border-left:3px solid ' + cor + ';background:#1a2030;border-radius:0 4px 4px 0;font-size:13px;color:#e6edf3;margin-bottom:4px;">'
        + ico + ' ' + a.msg + '</td></tr>';
    });
  }

  // ----- HTML: Recomendações -----
  var htmlRecos = '';
  recos.forEach(function(r) {
    htmlRecos += '<tr><td style="padding:9px 16px;font-size:13px;color:#e6edf3;border-bottom:1px solid #252d40;line-height:1.5;">' + r + '</td></tr>';
  });

  // ----- HTML: Top Operadores -----
  var htmlTopOp = '';
  var medalhas = ['🥇','🥈','🥉','4°','5°'];
  topOperadores.forEach(function(entry, i) {
    htmlTopOp += '<tr>'
      + '<td style="padding:7px 12px;font-size:20px;width:32px;">' + (medalhas[i] || (i+1)+'°') + '</td>'
      + '<td style="padding:7px 8px;font-size:13px;color:#e6edf3;">' + entry[0] + '</td>'
      + '<td style="padding:7px 12px;font-size:14px;font-weight:700;color:#f0b429;text-align:right;">' + entry[1] + '</td>'
      + '</tr>';
  });
  if (!htmlTopOp) htmlTopOp = '<tr><td colspan="3" style="padding:12px;color:#8b949e;font-size:13px;text-align:center;">Sem fechamentos nesta semana.</td></tr>';

  // ----- HTML: Top Operações -----
  var htmlTopOper = '';
  topOperacoes.forEach(function(entry) {
    htmlTopOper += '<tr>'
      + '<td style="padding:7px 14px;font-size:13px;color:#e6edf3;">' + entry[0] + '</td>'
      + '<td style="padding:7px 14px;font-size:13px;color:#38bdf8;font-weight:700;text-align:right;">' + entry[1] + '</td>'
      + '</tr>';
  });
  if (!htmlTopOper) htmlTopOper = '<tr><td colspan="2" style="padding:12px;color:#8b949e;font-size:13px;text-align:center;">Sem dados.</td></tr>';

  // ----- HTML: Backlog -----
  var htmlBacklog = '';
  var backlogTop10 = backlog.slice(0, 10);
  if (backlogTop10.length === 0) {
    htmlBacklog = '<tr><td colspan="4" style="padding:14px;color:#4ade80;font-size:13px;text-align:center;">✅ Nenhuma ordem em aberto.</td></tr>';
  } else {
    backlogTop10.forEach(function(o) {
      var diasAberto = Math.floor((agora - o.ts) / 86400000);
      var corDias    = diasAberto >= DIAS_ALERTA_ATRASO ? '#f87171' : '#8b949e';
      var peso       = diasAberto >= DIAS_ALERTA_ATRASO ? '700' : '400';
      var nome       = _rdNomeOp(o.func);
      htmlBacklog += '<tr>'
        + '<td style="padding:6px 10px;font-size:12px;color:#8b949e;border-bottom:1px solid #252d40;">' + fmt(new Date(o.ts)) + '</td>'
        + '<td style="padding:6px 10px;font-size:12px;color:#e6edf3;border-bottom:1px solid #252d40;">' + nome + '</td>'
        + '<td style="padding:6px 10px;font-size:12px;color:#8b949e;border-bottom:1px solid #252d40;">' + (o.op || '—') + '</td>'
        + '<td style="padding:6px 10px;font-size:12px;color:' + corDias + ';font-weight:' + peso + ';border-bottom:1px solid #252d40;text-align:right;">' + diasAberto + 'd</td>'
        + '</tr>';
    });
    if (backlog.length > 10) {
      htmlBacklog += '<tr><td colspan="4" style="padding:8px 10px;font-size:12px;color:#8b949e;text-align:center;">… e mais ' + (backlog.length - 10) + ' ordem(ns) em aberto</td></tr>';
    }
  }

  // ----- HTML: Trend 4 semanas (barras inline) -----
  var maxTrend = Math.max.apply(null, trend.map(function(t){ return Math.max(t.throughput, t.entradas, 1); }));
  var htmlTrend = '';
  trend.forEach(function(t, i) {
    var isAtual  = (i === 3);
    var hTp      = Math.max(4, Math.round((t.throughput / maxTrend) * 80));
    var hEn      = Math.max(4, Math.round((t.entradas   / maxTrend) * 80));
    var corTp    = isAtual ? '#f0b429' : '#4ade80';
    var semLabel = fmt(t.ini).substring(0, 5);
    htmlTrend += '<td style="text-align:center;padding:0 10px;vertical-align:bottom;">'
      + '<div style="display:inline-block;vertical-align:bottom;">'
      + '<div style="width:14px;height:' + hEn + 'px;background:#38bdf8;opacity:0.7;border-radius:2px 2px 0 0;display:inline-block;vertical-align:bottom;margin-right:2px;" title="Entradas: ' + t.entradas + '"></div>'
      + '<div style="width:14px;height:' + hTp + 'px;background:' + corTp + ';border-radius:2px 2px 0 0;display:inline-block;vertical-align:bottom;" title="Saídas: ' + t.throughput + '"></div>'
      + '</div>'
      + '<div style="font-size:10px;color:' + (isAtual ? '#f0b429' : '#8b949e') + ';margin-top:5px;font-weight:' + (isAtual ? '700' : '400') + ';">' + semLabel + '</div>'
      + '<div style="font-size:12px;color:' + corTp + ';font-weight:700;">' + t.throughput + '</div>'
      + '</td>';
  });

  // ===== MONTAGEM FINAL DO HTML =====
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#0a0e17;font-family:Arial,Helvetica,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:24px 12px;">'
    + '<tr><td align="center">'
    + '<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">'

    // ── CABEÇALHO ──
    + '<tr><td style="background:#0d1117;border-bottom:3px solid #f0b429;padding:24px 28px;border-radius:12px 12px 0 0;">'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td><div style="font-size:26px;font-weight:900;color:#f0b429;letter-spacing:3px;line-height:1;">AGRICEF</div>'
    + '<div style="font-size:11px;color:#58677a;letter-spacing:2px;margin-top:3px;text-transform:uppercase;">Sistema de Apontamento de Produção</div></td>'
    + '<td align="right">'
    + '<div style="font-size:16px;font-weight:700;color:#e6edf3;">📊 Relatório Semanal</div>'
    + '<div style="font-size:12px;color:#8b949e;margin-top:4px;">Semana: ' + semanaStr + '</div>'
    + '<div style="font-size:11px;color:#58677a;margin-top:2px;">Gerado em: ' + dataEnvio + '</div>'
    + '</td></tr></table></td></tr>'

    // ── KPI CARDS ──
    + '<tr><td style="background:#111722;padding:20px 28px 12px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'

    + '<td style="width:25%;padding:4px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;border-top:3px solid #4ade80;">'
    + '<tr><td style="padding:14px 12px;">'
    + '<div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">ENTREGAS</div>'
    + '<div style="font-size:30px;font-weight:900;color:#4ade80;line-height:1;">' + kpiAtual.throughput + '</div>'
    + '<div style="font-size:11px;color:' + deltaTPColor + ';margin-top:4px;">' + deltaTPStr + ' vs sem. ant.</div>'
    + '</td></tr></table></td>'

    + '<td style="width:25%;padding:4px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;border-top:3px solid #38bdf8;">'
    + '<tr><td style="padding:14px 12px;">'
    + '<div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">ENTRADAS</div>'
    + '<div style="font-size:30px;font-weight:900;color:#38bdf8;line-height:1;">' + kpiAtual.entradas + '</div>'
    + '<div style="font-size:11px;color:#8b949e;margin-top:4px;">novas ordens</div>'
    + '</td></tr></table></td>'

    + '<td style="width:25%;padding:4px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;border-top:3px solid ' + corBacklog + ';">'
    + '<tr><td style="padding:14px 12px;">'
    + '<div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">BACKLOG</div>'
    + '<div style="font-size:30px;font-weight:900;color:' + corBacklog + ';line-height:1;">' + backlog.length + '</div>'
    + '<div style="font-size:11px;color:#8b949e;margin-top:4px;">em aberto</div>'
    + '</td></tr></table></td>'

    + '<td style="width:25%;padding:4px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;border-top:3px solid #a78bfa;">'
    + '<tr><td style="padding:14px 12px;">'
    + '<div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">LEAD TIME</div>'
    + '<div style="font-size:30px;font-weight:900;color:#a78bfa;line-height:1;">' + (kpiAtual.leadMedio > 0 ? fmtH(kpiAtual.leadMedio) : '—') + '</div>'
    + '<div style="font-size:11px;color:#8b949e;margin-top:4px;">tempo médio/op</div>'
    + '</td></tr></table></td>'

    + '</tr></table></td></tr>'

    // ── ALERTAS ──
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">🚨 Alertas da Semana</div>'
    + '<table width="100%" cellpadding="0" cellspacing="3">' + htmlAlertas + '</table>'
    + '</td></tr>'

    // ── TENDÊNCIA 4 SEMANAS ──
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">📈 Tendência de Produção (4 semanas)</div>'
    + '<table cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;padding:12px 8px;width:100%;">'
    + '<tr><td style="padding:4px 14px 10px;" colspan="4">'
    + '<span style="display:inline-block;width:10px;height:10px;background:#38bdf8;border-radius:2px;margin-right:4px;opacity:0.7;"></span>'
    + '<span style="font-size:11px;color:#8b949e;">Entradas &nbsp;</span>'
    + '<span style="display:inline-block;width:10px;height:10px;background:#4ade80;border-radius:2px;margin-right:4px;"></span>'
    + '<span style="font-size:11px;color:#8b949e;">Saídas</span>'
    + '</td></tr>'
    + '<tr>' + htmlTrend + '</tr>'
    + '</table></td></tr>'

    // ── TOP OPERADORES + TOP OPERAÇÕES ──
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'

    + '<td style="width:50%;vertical-align:top;padding-right:8px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">👷 Top Operadores</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">' + htmlTopOp + '</table>'
    + '</td>'

    + '<td style="width:50%;vertical-align:top;padding-left:8px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">⚙️ Operações com + Saídas</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">' + htmlTopOper + '</table>'
    + '</td>'

    + '</tr></table></td></tr>'

    // ── BACKLOG DETALHADO ──
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">📋 Backlog Atual — ' + backlog.length + ' ordem' + (backlog.length !== 1 ? 's' : '') + ' em aberto</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">'
    + '<tr style="background:#141a28;">'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;font-weight:600;border-bottom:1px solid #252d40;">ABERTURA</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;font-weight:600;border-bottom:1px solid #252d40;">OPERADOR</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;font-weight:600;border-bottom:1px solid #252d40;">OPERAÇÃO</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:right;font-weight:600;border-bottom:1px solid #252d40;">DIAS</th>'
    + '</tr>'
    + htmlBacklog
    + '</table></td></tr>'

    // ── RECOMENDAÇÕES ──
    + '<tr><td style="background:#111722;padding:4px 28px 24px;border-radius:0 0 0 0;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">💡 Recomendações</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">' + htmlRecos + '</table>'
    + '</td></tr>'

    // ── ANÁLISE DE IA (opcional) ──
    + htmlAnaliseIA

    // ── FOOTER ──
    + '<tr><td style="background:#0d1117;padding:16px 28px;border-radius:0 0 12px 12px;border-top:1px solid #1c2230;text-align:center;">'
    + '<div style="font-size:11px;color:#58677a;">Este relatório é gerado automaticamente toda segunda-feira às 07h00 (Brasília).</div>'
    + '<div style="font-size:11px;color:#3a4460;margin-top:4px;">AGRICEF — Dashboard de Produção · Sistema de Apontamento v4</div>'
    + '</td></tr>'

    + '</table>'
    + '</td></tr></table>'
    + '</body></html>';
}

// ---------------------------------------------------------------
// ENVIO DO EMAIL
// ---------------------------------------------------------------
function _rsEnviarEmail(rel) {
  var dataStr = Utilities.formatDate(rel.agora, 'GMT-3', 'dd/MM/yyyy');
  var html    = _rsGerarHtml(rel);
  MailApp.sendEmail({
    to:       EMAIL_RELATORIO,
    subject:  '📊 AGRICEF | Relatório Semanal de Produção — ' + dataStr,
    htmlBody: html,
  });
}

// ---------------------------------------------------------------
// PARSER DE DATA — converte string dd/MM/yyyy HH:mm:ss → Date
// ---------------------------------------------------------------
function _rsParseData(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  const s = String(val).trim();
  // Formato principal: dd/MM/yyyy HH:mm:ss
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  // Fallback genérico
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ================================================================
//  RELATÓRIO DIÁRIO — AGRICEF
//
//  Enviado de segunda a sexta-feira às 06h45 (GMT-3).
//  Foco operacional: onde agir hoje, quem conversar, gargalos.
//
//  Para ativar, execute UMA VEZ: criarTriggerRelatorioDiario()
//  Para testar manualmente: execute enviarRelatorioDiario()
// ================================================================

// ---------------------------------------------------------------
// PONTO DE ENTRADA
// ---------------------------------------------------------------
function enviarRelatorioDiario() {
  try {
    const rel = _rdMontarRelatorio();
    rel.analiseIA = gerarAnaliseIA(rel, 'diario'); // null em caso de falha — não bloqueia o envio
    _rdEnviarEmail(rel);
    Logger.log('✅ Relatório diário enviado para ' + EMAIL_RELATORIO);
  } catch (err) {
    Logger.log('❌ Erro no relatório diário: ' + err.message + '\n' + err.stack);
    throw err;
  }
}

// ---------------------------------------------------------------
// CONFIGURAR TRIGGER DIÁRIO — executar UMA VEZ pelo Editor
// ---------------------------------------------------------------
function criarTriggerRelatorioDiario() {
  // Remove triggers duplicados
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'enviarRelatorioDiario'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  // Segunda a sexta às 06h45 (dispara entre 06h e 07h — não tem minutos exatos no Apps Script)
  var dias = [
    ScriptApp.WeekDay.MONDAY,
    ScriptApp.WeekDay.TUESDAY,
    ScriptApp.WeekDay.WEDNESDAY,
    ScriptApp.WeekDay.THURSDAY,
    ScriptApp.WeekDay.FRIDAY,
  ];
  dias.forEach(function(dia) {
    ScriptApp.newTrigger('enviarRelatorioDiario')
      .timeBased()
      .onWeekDay(dia)
      .atHour(7)   // entre 07h e 08h; antes do relatório semanal de segunda
      .create();
  });

  Logger.log('✅ Trigger diário criado: seg-sex às 07h (GMT-3).');
}

// ---------------------------------------------------------------
// HELPERS DE OPERADOR — tratam hífen (' - ') e em-dash (' — ')
// ---------------------------------------------------------------

// Extrai código numérico do campo func (ex: "130 — EDERSON" → "130")
function _rdCodigoOp(func) {
  var s = String(func || '').trim();
  var cod = s.split(/[\s\-—]+/)[0].trim();
  var n = Number(cod);
  return (!isNaN(n) && n > 0) ? String(n) : cod;
}

// Extrai nome limpo do campo func (ex: "130 — EDERSON LUIS" → "EDERSON LUIS")
function _rdNomeOp(func) {
  var s = String(func || '').trim();
  // Remove prefixo numérico e separador (hífen ou em-dash)
  var m = s.match(/^\d+\s*[\-—]\s*(.+)/);
  return m ? m[1].trim() : s;
}

// ---------------------------------------------------------------
// MONTAR RELATÓRIO DIÁRIO
// ---------------------------------------------------------------
function _rdMontarRelatorio() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) throw new Error('Aba "' + ABA_RESPOSTAS + '" não encontrada.');

  const dados = aba.getDataRange().getValues();
  const agora = new Date();

  // Janelas temporais
  const hoje      = new Date(agora); hoje.setHours(0,0,0,0);
  const ontem     = new Date(hoje);  ontem.setDate(hoje.getDate() - 1);
  const hojeFim   = new Date(hoje);  hojeFim.setHours(23,59,59,999);
  const ontemFim  = new Date(ontem); ontemFim.setHours(23,59,59,999);
  // "Esta semana" = últimos 7 dias para tendência rápida
  const semanaIni = new Date(hoje);  semanaIni.setDate(hoje.getDate() - 7);

  // --- Parse linhas (todos os tipos relevantes) ---
  const linhas = [];
  for (var i = 1; i < dados.length; i++) {
    var r = dados[i];
    if (!r[0] || !r[2]) continue;
    var ts = _rsParseData(r[0]);
    if (!ts) continue;
    var tipoRaw = String(r[2]).toUpperCase();
    var tipo = null;
    if      (tipoRaw.includes('ABERTURA') && !tipoRaw.includes('RETRABALHO')) tipo = 'ABERTURA';
    else if (tipoRaw.includes('FECHAMENTO'))                                   tipo = 'FECHAMENTO';
    else if (tipoRaw.includes('INÍCIO DE PARADA'))                             tipo = 'PARADA_INI';
    else if (tipoRaw.includes('INÍCIO DE RETRABALHO'))                         tipo = 'RETRAB_INI';
    else if (tipoRaw.includes('TÉRMINO DE RETRABALHO'))                        tipo = 'RETRAB_FIM';
    else continue;

    var campoF = String(r[5] || '');
    var pts    = campoF.split('|').map(function(x){ return x.trim(); });
    var funcRaw = String(r[1] || '').trim();
    linhas.push({
      ts,
      tipo,
      func:     funcRaw,
      funcCod:  _rdCodigoOp(funcRaw), // código numérico para pareamento robusto
      funcNome: _rdNomeOp(funcRaw),   // nome limpo para exibição
      op:    String(r[3] || '').trim(),
      item:  String(r[4] || '').trim(),
      serie: pts[0] || '',
      impl:  pts[1] || '',
      qty:   Number(r[6])  || 0,
    });
  }

  // --- Pareamento ABERTURA ↔ FECHAMENTO (two-pass greedy, usa código normalizado) ---
  var aberturas = linhas
    .filter(function(r){ return r.tipo === 'ABERTURA'; })
    .map(function(r){ return Object.assign({}, r, { _used: false, _fechTs: null, _leadMs: 0 }); });

  linhas
    .filter(function(r){ return r.tipo === 'FECHAMENTO'; })
    .forEach(function(fech) {
      var melhor = null, melhorScore = -1;
      for (var i = 0; i < aberturas.length; i++) {
        var a = aberturas[i];
        // Usa funcCod para tolerância a hífen vs em-dash e variações de código
        if (a._used || a.funcCod !== fech.funcCod || a.ts > fech.ts) continue;
        var score = 1;
        if (a.op    === fech.op)    score += 4;
        if (a.serie === fech.serie) score += 2;
        if (a.item  === fech.item)  score += 1;
        // Empate: prefere a ABERTURA mais recente (mais próxima do FECHAMENTO)
        if (score > melhorScore || (score === melhorScore && melhor !== null && a.ts > aberturas[melhor].ts)) {
          melhorScore = score; melhor = i;
        }
      }
      if (melhor !== null) {
        aberturas[melhor]._used   = true;
        aberturas[melhor]._fechTs = fech.ts;
        aberturas[melhor]._leadMs = fech.ts - aberturas[melhor].ts;
      }
    });

  var backlog   = aberturas.filter(function(a){ return !a._used; })
                            .sort(function(x, y){ return x.ts - y.ts; }); // mais antigas primeiro
  var fechadas  = aberturas.filter(function(a){ return a._used; });

  // --- Aberturas e fechamentos HOJE e ONTEM ---
  var aberturasHoje  = linhas.filter(function(r){ return r.tipo==='ABERTURA' && r.ts >= hoje && r.ts <= hojeFim; });
  var fechamentosHoje= fechadas.filter(function(r){ return r._fechTs >= hoje && r._fechTs <= hojeFim; });
  var aberturasOntem = linhas.filter(function(r){ return r.tipo==='ABERTURA' && r.ts >= ontem && r.ts <= ontemFim; });
  var fechamentosOntem=fechadas.filter(function(r){ return r._fechTs >= ontem && r._fechTs <= ontemFim; });

  // Prefere ontem se hoje não tem dados ainda (relatório às 07h)
  var refDiaLabel = aberturasHoje.length > 0 || fechamentosHoje.length > 0 ? 'Hoje' : 'Ontem';
  var refAberturas = refDiaLabel === 'Hoje' ? aberturasHoje  : aberturasOntem;
  var refFechados  = refDiaLabel === 'Hoje' ? fechamentosHoje : fechamentosOntem;

  // --- Backlog por operador (quem conversar) — agrupa por código normalizado ---
  var backlogPorOp = {};
  backlog.forEach(function(o){
    var cod  = o.funcCod  || o.func;
    var nome = o.funcNome || o.func;
    if (!backlogPorOp[cod]) backlogPorOp[cod] = { count: 0, ordens: [], nome: nome };
    backlogPorOp[cod].count++;
    backlogPorOp[cod].ordens.push(o);
  });
  var topBacklogOp = Object.values(backlogPorOp)
    .sort(function(a,b){ return b.count - a.count; })
    .slice(0, 5);

  // --- Ordens mais antigas em aberto ---
  var ordensAntigas = backlog.slice(0, 8);

  // --- Backlog por operação (gargalos) ---
  var backlogPorOperacao = {};
  backlog.forEach(function(o){
    var op = o.op || '(sem operação)';
    backlogPorOperacao[op] = (backlogPorOperacao[op] || 0) + 1;
  });
  var topGargalos = Object.entries(backlogPorOperacao)
    .sort(function(a,b){ return b[1]-a[1]; })
    .slice(0, 3);

  // --- Backlog por série (foco em produto) ---
  var backlogPorSerie = {};
  backlog.forEach(function(o){
    if (!o.serie) return;
    if (!backlogPorSerie[o.serie]) backlogPorSerie[o.serie] = { count: 0, impl: o.impl || '' };
    backlogPorSerie[o.serie].count++;
  });
  var topSeries = Object.entries(backlogPorSerie)
    .sort(function(a,b){ return b[1].count-a[1].count; })
    .slice(0, 5);

  // --- Operadores sem atividade nos últimos 2 dias úteis ---
  // Agrupados por código normalizado para evitar duplicatas (hífen vs em-dash)
  var dois_dias_atras = new Date(hoje); dois_dias_atras.setDate(hoje.getDate() - 2);
  var ativosRecentesCod = new Set(
    linhas.filter(function(r){ return r.ts >= dois_dias_atras; })
          .map(function(r){ return r.funcCod || r.func; })
  );
  var todosOpsCod = {}; // cod → nome
  linhas.forEach(function(r){
    var cod = r.funcCod || r.func;
    if (!todosOpsCod[cod]) todosOpsCod[cod] = r.funcNome || r.func;
  });
  var semAtividade = Object.entries(todosOpsCod)
    .filter(function(e){ return !ativosRecentesCod.has(e[0]); })
    .map(function(e){ return e[1]; })
    .sort();

  // --- Retrabalhos ativos ---
  var retrabs = linhas.filter(function(r){ return r.tipo === 'RETRAB_INI'; });
  var retrAbertos = retrabs.filter(function(ri){
    return !linhas.some(function(rf){
      return rf.tipo === 'RETRAB_FIM' && rf.funcCod === ri.funcCod && rf.ts > ri.ts;
    });
  });

  // --- Alertas diários ---
  var alertas = _rdAlertas(backlog, refFechados, refAberturas, topBacklogOp, ordensAntigas, agora);

  // --- Ações recomendadas ---
  var acoes = _rdAcoes(backlog, topBacklogOp, topGargalos, ordensAntigas, semAtividade, refFechados, retrAbertos);

  return {
    agora, hoje, refDiaLabel,
    aberturasRef: refAberturas, fechadosRef: refFechados,
    backlog, topBacklogOp, ordensAntigas, topGargalos, topSeries,
    semAtividade, retrAbertos, alertas, acoes,
  };
}

// ---------------------------------------------------------------
// ALERTAS DIÁRIOS
// ---------------------------------------------------------------
function _rdAlertas(backlog, fechados, aberturas, topOps, antigas, agora) {
  var lista = [];
  var limiteMs = 3 * 86400000; // 3 dias

  if (backlog.length >= 20) {
    lista.push({ nivel: 'CRITICO', msg: 'Backlog crítico: ' + backlog.length + ' ordens em aberto. Intervenção imediata necessária.' });
  } else if (backlog.length >= 10) {
    lista.push({ nivel: 'ATENCAO', msg: 'Backlog elevado: ' + backlog.length + ' ordens em aberto. Monitorar e acelerar fechamentos.' });
  }

  var antigas3d = backlog.filter(function(o){ return (agora - o.ts) > limiteMs; });
  if (antigas3d.length > 0) {
    lista.push({ nivel: 'CRITICO', msg: antigas3d.length + ' ordem(ns) aberta(s) há mais de 3 dias. Investigar imediatamente.' });
  }

  if (fechados.length === 0 && aberturas.length === 0) {
    lista.push({ nivel: 'ATENCAO', msg: 'Nenhum apontamento registrado no dia de referência. Verificar se operadores usaram o sistema.' });
  }

  if (topOps.length > 0 && topOps[0].count >= 5) {
    lista.push({ nivel: 'ATENCAO', msg: topOps[0].nome + ' acumula ' + topOps[0].count + ' ordens em aberto — conversa prioritária hoje.' });
  }

  return lista;
}

// ---------------------------------------------------------------
// AÇÕES RECOMENDADAS PARA O DIA
// ---------------------------------------------------------------
function _rdAcoes(backlog, topOps, topGargalos, antigas, semAtividade, fechados, retrabs) {
  var lista = [];
  var limiteMs = 3 * 86400000;
  var agora = new Date();

  // 1. Conversar com operadores com mais backlog
  if (topOps.length > 0) {
    var nomes = topOps.slice(0, 3).map(function(o){ return o.nome + ' (' + o.count + ')'; }).join(', ');
    lista.push('💬 <b>Conversar hoje com:</b> ' + nomes + ' — entender o que impede o fechamento das ordens em aberto.');
  }

  // 2. Ordens mais antigas
  var antigas3d = backlog.filter(function(o){ return (agora - o.ts) > limiteMs; });
  if (antigas3d.length > 0) {
    var seriesAntigas = [...new Set(antigas3d.map(function(o){ return o.serie; }).filter(Boolean))].slice(0,3).join(', ');
    lista.push('🔴 <b>Prioridade máxima:</b> ' + antigas3d.length + ' ordem(ns) com mais de 3 dias em aberto.'
      + (seriesAntigas ? ' Séries: ' + seriesAntigas + '.' : '')
      + ' Verificar se há impedimento de material, máquina ou informação.');
  }

  // 3. Gargalo de operação
  if (topGargalos.length > 0 && topGargalos[0][1] >= 3) {
    lista.push('🔧 <b>Gargalo detectado:</b> operação <i>' + topGargalos[0][0] + '</i> concentra ' + topGargalos[0][1]
      + ' ordens do backlog. Avaliar reforço de equipe ou resequenciamento nesta etapa.');
  }

  // 4. Operadores sem atividade
  if (semAtividade.length > 0 && semAtividade.length <= 5) {
    lista.push('📋 <b>Sem apontamento nos últimos 2 dias:</b> ' + semAtividade.slice(0,4).join(', ')
      + '. Verificar presença e garantir que os registros estão sendo feitos corretamente.');
  } else if (semAtividade.length > 5) {
    lista.push('📋 <b>' + semAtividade.length + ' operadores</b> sem apontamento nos últimos 2 dias. Verificar aderência ao sistema de apontamento.');
  }

  // 5. Retrabalhos em aberto
  if (retrabs.length > 0) {
    var opRetrabs = [...new Set(retrabs.map(function(r){ return _rdNomeOp(r.func); }))];
    lista.push('🔄 <b>Retrabalho em andamento:</b> ' + opRetrabs.join(', ')
      + '. Acompanhar conclusão e registrar término de retrabalho no sistema.');
  }

  // 6. Desempenho ontem/hoje
  if (fechados.length >= 5) {
    lista.push('✅ <b>Bom ritmo:</b> ' + fechados.length + ' fechamentos registrados. Manter a cadência e garantir novos apontamentos de abertura.');
  } else if (fechados.length > 0) {
    lista.push('📈 <b>Apenas ' + fechados.length + ' fechamento(s).</b> Estimular operadores a concluir e registrar as operações em andamento.');
  }

  if (lista.length === 0) {
    lista.push('✅ Nenhum ponto crítico identificado para hoje. Manter cadência de apontamentos e foco na qualidade dos registros.');
  }

  return lista;
}

// ---------------------------------------------------------------
// GERAÇÃO DO HTML DO EMAIL DIÁRIO
// ---------------------------------------------------------------
function _rdGerarHtml(rel) {
  var { agora, refDiaLabel, aberturasRef, fechadosRef,
        backlog, topBacklogOp, ordensAntigas, topGargalos, topSeries,
        semAtividade, retrAbertos, alertas, acoes, analiseIA } = rel;

  // ----- HTML: Análise de IA (opcional — só aparece se gerarAnaliseIA teve sucesso) -----
  var htmlAnaliseIA = '';
  if (analiseIA) {
    var paragrafosIA = String(analiseIA).split(/\n+/).filter(function(p) { return p.trim() !== ''; });
    var corpoIA = paragrafosIA.map(function(p) {
      return '<p style="margin:0 0 10px;font-size:13px;color:#e6edf3;line-height:1.6;">' + p + '</p>';
    }).join('');
    htmlAnaliseIA = '<tr><td style="background:#111722;padding:4px 28px 16px;">'
      + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">🤖 Análise do Analista de Produção Virtual</div>'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;"><tr><td style="padding:14px 16px;">'
      + corpoIA
      + '</td></tr></table></td></tr>';
  }

  var fmt      = function(d){ return Utilities.formatDate(d, 'GMT-3', 'dd/MM/yyyy'); };
  var fmtHora  = function(d){ return Utilities.formatDate(d, 'GMT-3', 'HH:mm'); };
  var dataEnvio= Utilities.formatDate(agora, 'GMT-3', "dd/MM/yyyy 'às' HH:mm");
  var diaSemana= ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'][agora.getDay()];

  // Cor do backlog
  var corBacklog = backlog.length >= 20 ? '#f87171' : backlog.length >= 10 ? '#fb923c' : '#4ade80';

  // ── HTML Alertas ──
  var htmlAlertas = '';
  if (alertas.length === 0) {
    htmlAlertas = '<tr><td style="padding:10px 14px;color:#4ade80;font-size:13px;">✅ Sem alertas críticos para hoje.</td></tr>';
  } else {
    alertas.forEach(function(a) {
      var cor = a.nivel === 'CRITICO' ? '#f87171' : '#fb923c';
      var ico = a.nivel === 'CRITICO' ? '🔴' : '🟡';
      htmlAlertas += '<tr><td style="padding:9px 14px;border-left:3px solid ' + cor + ';background:#1a2030;border-radius:0 4px 4px 0;font-size:13px;color:#e6edf3;margin-bottom:4px;">' + ico + ' ' + a.msg + '</td></tr>';
    });
  }

  // ── HTML Ações ──
  var htmlAcoes = '';
  acoes.forEach(function(a) {
    htmlAcoes += '<tr><td style="padding:9px 16px;font-size:13px;color:#e6edf3;border-bottom:1px solid #252d40;line-height:1.55;">' + a + '</td></tr>';
  });

  // ── HTML KPIs cards ──
  var card = function(cor, label, valor, sub) {
    return '<td style="width:25%;padding:4px;">'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;border-top:3px solid ' + cor + ';">'
      + '<tr><td style="padding:12px 10px;">'
      + '<div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">' + label + '</div>'
      + '<div style="font-size:28px;font-weight:900;color:' + cor + ';line-height:1;">' + valor + '</div>'
      + '<div style="font-size:11px;color:#8b949e;margin-top:3px;">' + sub + '</div>'
      + '</td></tr></table></td>';
  };

  var htmlCards = ''
    + card('#fca5a5', 'BACKLOG TOTAL', backlog.length, 'ordens sem fechamento')
    + card('#4ade80', refDiaLabel + ' — ENTREGAS', fechadosRef.length, 'ops concluídas')
    + card('#38bdf8', refDiaLabel + ' — ENTRADAS', aberturasRef.length, 'novas aberturas')
    + card('#fb923c', 'MAIS ANTIGO', ordensAntigas.length > 0
        ? Math.floor((agora - ordensAntigas[0].ts) / 86400000) + 'd'
        : '—',
        ordensAntigas.length > 0 ? 'dias sem fechar' : 'tudo ok');

  // ── HTML Quem conversar ──
  var htmlConversas = '';
  if (topBacklogOp.length === 0) {
    htmlConversas = '<tr><td colspan="2" style="padding:12px;color:#4ade80;font-size:13px;text-align:center;">✅ Nenhum backlog pendente.</td></tr>';
  } else {
    topBacklogOp.forEach(function(op) {
      var corQ = op.count >= 5 ? '#f87171' : op.count >= 3 ? '#fb923c' : '#8b949e';
      var series = [...new Set(op.ordens.map(function(o){ return o.serie; }).filter(Boolean))].slice(0,3).join(', ');
      htmlConversas += '<tr>'
        + '<td style="padding:8px 10px;font-size:13px;color:#e6edf3;border-bottom:1px solid #252d40;">' + op.nome + '</td>'
        + '<td style="padding:8px 10px;font-size:13px;font-weight:700;color:' + corQ + ';border-bottom:1px solid #252d40;text-align:center;">' + op.count + ' ordens</td>'
        + '<td style="padding:8px 10px;font-size:11px;color:#8b949e;border-bottom:1px solid #252d40;">' + (series||'—') + '</td>'
        + '</tr>';
    });
  }

  // ── HTML Ordens Antigas ──
  var htmlAntigas = '';
  if (ordensAntigas.length === 0) {
    htmlAntigas = '<tr><td colspan="4" style="padding:12px;color:#4ade80;font-size:13px;text-align:center;">✅ Nenhuma ordem com mais de 3 dias.</td></tr>';
  } else {
    ordensAntigas.forEach(function(o) {
      var dias     = Math.floor((agora - o.ts) / 86400000);
      var corDias  = dias >= 5 ? '#f87171' : dias >= 3 ? '#fb923c' : '#8b949e';
      var nome     = _rdNomeOp(o.func);
      htmlAntigas += '<tr>'
        + '<td style="padding:6px 10px;font-size:11px;color:#8b949e;border-bottom:1px solid #252d40;">' + fmt(o.ts) + '</td>'
        + '<td style="padding:6px 10px;font-size:12px;color:#e6edf3;border-bottom:1px solid #252d40;">' + nome + '</td>'
        + '<td style="padding:6px 10px;font-size:12px;color:#38bdf8;border-bottom:1px solid #252d40;">' + (o.op||'—') + '</td>'
        + '<td style="padding:6px 10px;font-size:12px;font-weight:700;color:' + corDias + ';border-bottom:1px solid #252d40;text-align:right;">' + dias + 'd</td>'
        + '</tr>';
    });
  }

  // ── HTML Gargalos ──
  var htmlGargalos = '';
  if (topGargalos.length === 0) {
    htmlGargalos = '<tr><td colspan="2" style="padding:12px;color:#4ade80;font-size:13px;text-align:center;">Sem gargalos identificados.</td></tr>';
  } else {
    var maxG = topGargalos[0][1];
    topGargalos.forEach(function(g, i) {
      var pct = Math.max(8, Math.round(g[1] / maxG * 100));
      var cor = i === 0 ? '#f87171' : '#fb923c';
      htmlGargalos += '<tr>'
        + '<td style="padding:8px 12px;font-size:12px;color:#e6edf3;border-bottom:1px solid #252d40;width:50%;">' + g[0] + '</td>'
        + '<td style="padding:8px 12px;border-bottom:1px solid #252d40;">'
        + '<div style="display:flex;align-items:center;gap:8px;">'
        + '<div style="flex:1;height:10px;background:#252d40;border-radius:3px;overflow:hidden;">'
        + '<div style="width:' + pct + '%;height:100%;background:' + cor + ';border-radius:3px;"></div></div>'
        + '<span style="font-size:12px;font-weight:700;color:' + cor + ';min-width:24px;text-align:right;">' + g[1] + '</span>'
        + '</div></td>'
        + '</tr>';
    });
  }

  // ── HTML Séries com Backlog ──
  var htmlSeries = '';
  if (topSeries.length === 0) {
    htmlSeries = '<tr><td colspan="3" style="padding:12px;color:#4ade80;font-size:13px;text-align:center;">Sem backlog por série.</td></tr>';
  } else {
    topSeries.forEach(function(entry) {
      var s = entry[0], v = entry[1];
      htmlSeries += '<tr>'
        + '<td style="padding:7px 10px;font-size:13px;font-weight:700;color:#38bdf8;border-bottom:1px solid #252d40;">' + s + '</td>'
        + '<td style="padding:7px 10px;font-size:12px;color:#8b949e;border-bottom:1px solid #252d40;">' + (v.impl||'—') + '</td>'
        + '<td style="padding:7px 10px;font-size:12px;font-weight:700;color:#fca5a5;border-bottom:1px solid #252d40;text-align:right;">' + v.count + ' abertas</td>'
        + '</tr>';
    });
  }

  // ── MONTAGEM FINAL ──
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#0a0e17;font-family:Arial,Helvetica,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:24px 12px;">'
    + '<tr><td align="center">'
    + '<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">'

    // CABEÇALHO
    + '<tr><td style="background:#0d1117;border-bottom:3px solid #38bdf8;padding:20px 28px;border-radius:12px 12px 0 0;">'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td><div style="font-size:26px;font-weight:900;color:#f0b429;letter-spacing:3px;line-height:1;">AGRICEF</div>'
    + '<div style="font-size:11px;color:#58677a;letter-spacing:2px;margin-top:3px;text-transform:uppercase;">Relatório Operacional Diário</div></td>'
    + '<td align="right">'
    + '<div style="font-size:15px;font-weight:700;color:#38bdf8;">🗓️ ' + diaSemana + ', ' + fmt(agora) + '</div>'
    + '<div style="font-size:11px;color:#58677a;margin-top:3px;">Gerado às ' + fmtHora(agora) + ' (Brasília)</div>'
    + '</td></tr></table></td></tr>'

    // ALERTAS
    + '<tr><td style="background:#111722;padding:16px 28px 4px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f87171;text-transform:uppercase;letter-spacing:1.5px;padding:0 0 8px;">🚨 Pontos Críticos de Hoje</div>'
    + '<table width="100%" cellpadding="0" cellspacing="3">' + htmlAlertas + '</table>'
    + '</td></tr>'

    // AÇÕES DO DIA
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<div style="font-size:12px;font-weight:700;color:#4ade80;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">⚡ Ações para Hoje</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">' + htmlAcoes + '</table>'
    + '</td></tr>'

    // KPI CARDS
    + '<tr><td style="background:#111722;padding:4px 28px 12px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f0b429;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">📊 Situação do Dia</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>' + htmlCards + '</tr></table>'
    + '</td></tr>'

    // QUEM CONVERSAR
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<div style="font-size:12px;font-weight:700;color:#fb923c;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">💬 Com Quem Falar Hoje (Top Backlog por Operador)</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">'
    + '<tr style="background:#141a28;">'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;border-bottom:1px solid #252d40;">OPERADOR</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:center;border-bottom:1px solid #252d40;">BACKLOG</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;border-bottom:1px solid #252d40;">SÉRIES</th>'
    + '</tr>'
    + htmlConversas
    + '</table></td></tr>'

    // ORDENS MAIS ANTIGAS
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<div style="font-size:12px;font-weight:700;color:#f87171;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">⏰ Ordens Mais Antigas em Aberto</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">'
    + '<tr style="background:#141a28;">'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;border-bottom:1px solid #252d40;">ABERTURA</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;border-bottom:1px solid #252d40;">OPERADOR</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:left;border-bottom:1px solid #252d40;">OPERAÇÃO</th>'
    + '<th style="padding:8px 10px;font-size:11px;color:#8b949e;text-align:right;border-bottom:1px solid #252d40;">DIAS</th>'
    + '</tr>'
    + htmlAntigas
    + '</table></td></tr>'

    // GARGALOS + SÉRIES
    + '<tr><td style="background:#111722;padding:4px 28px 16px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'

    + '<td style="width:50%;vertical-align:top;padding-right:8px;">'
    + '<div style="font-size:12px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">🔧 Gargalos (Op. com Mais Backlog)</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">' + htmlGargalos + '</table>'
    + '</td>'

    + '<td style="width:50%;vertical-align:top;padding-left:8px;">'
    + '<div style="font-size:12px;font-weight:700;color:#67e8f9;text-transform:uppercase;letter-spacing:1.5px;padding:10px 0 8px;">📦 Séries com Mais Backlog</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1c2230;border:1px solid #252d40;border-radius:8px;">' + htmlSeries + '</table>'
    + '</td>'

    + '</tr></table></td></tr>'

    // ── ANÁLISE DE IA (opcional) ──
    + htmlAnaliseIA

    // FOOTER
    + '<tr><td style="background:#0d1117;padding:14px 28px;border-radius:0 0 12px 12px;border-top:1px solid #1c2230;text-align:center;">'
    + '<div style="font-size:11px;color:#58677a;">Relatório gerado automaticamente de segunda a sexta às 07h (Brasília).</div>'
    + '<div style="font-size:11px;color:#3a4460;margin-top:3px;">AGRICEF — Dashboard de Produção · Sistema de Apontamento v4 '
    + '| <a href="https://agricefprocessos-tech.github.io/agricef-dashboard/" style="color:#38bdf8;text-decoration:none;">Abrir Dashboard</a></div>'
    + '</td></tr>'

    + '</table>'
    + '</td></tr></table>'
    + '</body></html>';
}

// ---------------------------------------------------------------
// ENVIO DO EMAIL DIÁRIO
// ---------------------------------------------------------------
function _rdEnviarEmail(rel) {
  var dataStr = Utilities.formatDate(rel.agora, 'GMT-3', 'dd/MM/yyyy');
  var html = _rdGerarHtml(rel);
  MailApp.sendEmail({
    to:       EMAIL_RELATORIO,
    subject:  '⚡ AGRICEF | Relatório Diário — ' + dataStr,
    htmlBody: html,
  });
}

// ================================================================
// ANÁLISE DE ÓRFÃOS (ABERTURAs sem FECHAMENTO correspondente)
// Execute via: ?action=analyzeOrphans&key=AGF2026
// ================================================================
function analisarOrfaos() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) throw new Error('Aba Respostas não encontrada.');

  const dados = aba.getDataRange().getValues();
  const agora = new Date();

  // Parse de todas as linhas de ABERTURA e FECHAMENTO
  const linhas = [];
  for (var i = 1; i < dados.length; i++) {
    var r = dados[i];
    if (!r[0] || !r[2]) continue;
    var ts = new Date(r[0]);
    if (isNaN(ts.getTime())) continue;
    var tipoRaw = String(r[2]).toUpperCase();
    var tipo = null;
    if (tipoRaw.includes('ABERTURA') && !tipoRaw.includes('RETRABALHO')) tipo = 'ABERTURA';
    else if (tipoRaw.includes('FECHAMENTO')) tipo = 'FECHAMENTO';
    else continue;
    var funcRaw = String(r[1] || '').trim();
    var campoF  = String(r[5] || '');
    var pts     = campoF.split('|').map(function(x){ return x.trim(); });
    linhas.push({
      ts:      ts,
      tipo:    tipo,
      func:    funcRaw,
      funcCod: _rdCodigoOp(funcRaw),
      op:      String(r[3] || '').trim(),
      item:    String(r[4] || '').trim(),
      serie:   pts[0] || '',
      impl:    pts[1] || '',
      row:     i + 1,  // linha na planilha (base 1, +1 pelo cabeçalho)
    });
  }

  // Algoritmo de pareamento idêntico ao relatório
  var aberturas = linhas.filter(function(r){ return r.tipo === 'ABERTURA'; })
    .map(function(r){ return Object.assign({}, r, { _used: false }); });

  linhas.filter(function(r){ return r.tipo === 'FECHAMENTO'; })
    .forEach(function(fech){
      var melhor = null, melhorScore = -1;
      for (var i = 0; i < aberturas.length; i++) {
        var a = aberturas[i];
        if (a._used || a.funcCod !== fech.funcCod || a.ts > fech.ts) continue;
        var score = 1;
        if (a.op    === fech.op)    score += 4;
        if (a.serie === fech.serie) score += 2;
        if (a.item  === fech.item)  score += 1;
        // Empate: prefere a ABERTURA mais recente (mais próxima do FECHAMENTO)
        if (score > melhorScore || (score === melhorScore && melhor !== null && a.ts > aberturas[melhor].ts)) {
          melhorScore = score; melhor = i;
        }
      }
      if (melhor !== null) aberturas[melhor]._used = true;
    });

  var orfaos = aberturas.filter(function(a){ return !a._used; });

  // Agrupa órfãos por faixa de data
  var cortes = {
    antes_fev2026:  new Date('2026-02-01T00:00:00'),
    antes_mar2026:  new Date('2026-03-01T00:00:00'),
    antes_abr2026:  new Date('2026-04-01T00:00:00'),
    antes_mai2026:  new Date('2026-05-01T00:00:00'),
  };

  var porFaixa = {
    'Antes de Fev/2026':  [],
    'Fev/2026':           [],
    'Mar/2026':           [],
    'Abr/2026':           [],
    'Mai/2026 em diante': [],
  };

  orfaos.forEach(function(o){
    var d = o.ts;
    if      (d < cortes.antes_fev2026) porFaixa['Antes de Fev/2026'].push(o);
    else if (d < cortes.antes_mar2026) porFaixa['Fev/2026'].push(o);
    else if (d < cortes.antes_abr2026) porFaixa['Mar/2026'].push(o);
    else if (d < cortes.antes_mai2026) porFaixa['Abr/2026'].push(o);
    else                               porFaixa['Mai/2026 em diante'].push(o);
  });

  // Agrupa por operador
  var porOperador = {};
  orfaos.forEach(function(o){
    var k = o.funcCod || o.func;
    if (!porOperador[k]) porOperador[k] = { func: o.func, funcCod: o.funcCod, count: 0, datas: [] };
    porOperador[k].count++;
    var dtStr = Utilities.formatDate(o.ts, 'GMT-3', 'dd/MM/yyyy');
    if (porOperador[k].datas.indexOf(dtStr) === -1) porOperador[k].datas.push(dtStr);
  });

  // Agrupa por operação
  var porOperacao = {};
  orfaos.forEach(function(o){
    var k = o.op || '(sem operação)';
    porOperacao[k] = (porOperacao[k] || 0) + 1;
  });

  // Impacto na assiduidade: dias únicos por operador contribuídos apenas por órfãos
  // (dias em que o operador SÓ tem órfão, sem outros registros)
  var diasPorOp = {};   // todos os registros (para comparar)
  var diasOrfaoPorOp = {};
  linhas.forEach(function(r){
    var k = r.funcCod || r.func;
    var d = Utilities.formatDate(r.ts, 'GMT-3', 'dd/MM/yyyy');
    if (!diasPorOp[k]) diasPorOp[k] = new Set();
    diasPorOp[k].add(d);
  });
  orfaos.forEach(function(o){
    var k = o.funcCod || o.func;
    var d = Utilities.formatDate(o.ts, 'GMT-3', 'dd/MM/yyyy');
    if (!diasOrfaoPorOp[k]) diasOrfaoPorOp[k] = new Set();
    diasOrfaoPorOp[k].add(d);
  });

  // Linhas de não-órfãos por operador e data
  var diasComOutros = {};
  var orfaoRows = new Set(orfaos.map(function(o){ return o.row; }));
  linhas.forEach(function(r){
    if (orfaoRows.has(r.row)) return;  // é órfão ele mesmo — pula
    var k = r.funcCod || r.func;
    var d = Utilities.formatDate(r.ts, 'GMT-3', 'dd/MM/yyyy');
    if (!diasComOutros[k]) diasComOutros[k] = new Set();
    diasComOutros[k].add(d);
  });

  // Dias que seriam perdidos na assiduidade (só existem por causa do órfão)
  var diasPerdidosTotal = 0;
  var assiduidadeImpacto = [];
  Object.keys(diasOrfaoPorOp).forEach(function(k){
    var perdidos = 0;
    diasOrfaoPorOp[k].forEach(function(d){
      if (!diasComOutros[k] || !diasComOutros[k].has(d)) perdidos++;
    });
    if (perdidos > 0) {
      diasPerdidosTotal += perdidos;
      assiduidadeImpacto.push({ funcCod: k, diasPerdidos: perdidos });
    }
  });

  // Resumo por faixa (simplificado para o JSON de resposta)
  var resumoFaixas = {};
  Object.keys(porFaixa).forEach(function(k){
    resumoFaixas[k] = porFaixa[k].length;
  });

  // Top operadores por qtd de órfãos
  var topOps = Object.values(porOperador)
    .sort(function(a,b){ return b.count - a.count; })
    .slice(0, 15)
    .map(function(o){ return { func: o.func, funcCod: o.funcCod, count: o.count }; });

  // Top operações
  var topOps2 = Object.entries(porOperacao)
    .sort(function(a,b){ return b[1]-a[1]; })
    .map(function(e){ return { operacao: e[0], count: e[1] }; });

  // Data do órfão mais antigo e mais recente
  var datas = orfaos.map(function(o){ return o.ts.getTime(); });
  var maisAntigo = datas.length ? new Date(Math.min.apply(null, datas)) : null;
  var maisRecente = datas.length ? new Date(Math.max.apply(null, datas)) : null;

  return {
    success: true,
    totais: {
      totalRegistros:    linhas.length,
      totalAberturas:    aberturas.length,
      totalFechamentos:  linhas.filter(function(r){ return r.tipo === 'FECHAMENTO'; }).length,
      totalPareados:     aberturas.filter(function(a){ return a._used; }).length,
      totalOrfaos:       orfaos.length,
      maisAntigo:        maisAntigo ? Utilities.formatDate(maisAntigo, 'GMT-3', 'dd/MM/yyyy') : null,
      maisRecente:       maisRecente ? Utilities.formatDate(maisRecente, 'GMT-3', 'dd/MM/yyyy') : null,
    },
    porFaixa:           resumoFaixas,
    porOperador:        topOps,
    porOperacao:        topOps2,
    impactoAssiduidade: {
      operadoresAfetados: assiduidadeImpacto.length,
      diasPerdidosTotal:  diasPerdidosTotal,
      detalhe:            assiduidadeImpacto,
    },
    geradoEm: Utilities.formatDate(agora, 'GMT-3', 'dd/MM/yyyy HH:mm:ss'),
  };
}

// ================================================================
// MARCAR ÓRFÃOS COMO LEGADO (adiciona marcação na coluna de obs)
// Parâmetro cutoff: data no formato "YYYY-MM-DD" (ex: "2026-03-01")
// Marca todos os órfãos ANTERIORES à data informada.
// Execute via: ?action=marcarLegado&key=AGF2026&cutoff=2026-03-01
// ================================================================
function marcarOrfaosLegado(cutoffStr) {
  var cutoff = cutoffStr ? new Date(cutoffStr + 'T00:00:00') : null;
  if (!cutoff || isNaN(cutoff.getTime())) throw new Error('Parâmetro cutoff inválido. Use formato YYYY-MM-DD.');

  var ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  var aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) throw new Error('Aba Respostas não encontrada.');

  var dados = aba.getDataRange().getValues();

  // Mesmo algoritmo de pareamento para identificar órfãos
  var linhas = [];
  for (var i = 1; i < dados.length; i++) {
    var r = dados[i];
    if (!r[0] || !r[2]) continue;
    var ts = new Date(r[0]);
    if (isNaN(ts.getTime())) continue;
    var tipoRaw = String(r[2]).toUpperCase();
    var tipo = null;
    if (tipoRaw.includes('ABERTURA') && !tipoRaw.includes('RETRABALHO')) tipo = 'ABERTURA';
    else if (tipoRaw.includes('FECHAMENTO')) tipo = 'FECHAMENTO';
    else continue;
    var funcRaw = String(r[1] || '').trim();
    var pts = String(r[5] || '').split('|').map(function(x){ return x.trim(); });
    linhas.push({ ts, tipo, funcCod: _rdCodigoOp(funcRaw), op: String(r[3]||'').trim(),
                  serie: pts[0]||'', item: String(r[4]||'').trim(), row: i+1, _used: false });
  }

  var aberturas = linhas.filter(function(r){ return r.tipo === 'ABERTURA'; });
  linhas.filter(function(r){ return r.tipo === 'FECHAMENTO'; }).forEach(function(fech){
    var melhor = null, melhorScore = -1;
    for (var i = 0; i < aberturas.length; i++) {
      var a = aberturas[i];
      if (a._used || a.funcCod !== fech.funcCod || a.ts > fech.ts) continue;
      var score = 1;
      if (a.op === fech.op) score += 4;
      if (a.serie === fech.serie) score += 2;
      if (a.item === fech.item) score += 1;
      // Empate: prefere a ABERTURA mais recente (mais próxima do FECHAMENTO)
      if (score > melhorScore || (score === melhorScore && melhor !== null && a.ts > aberturas[melhor].ts)) {
        melhorScore = score; melhor = i;
      }
    }
    if (melhor !== null) aberturas[melhor]._used = true;
  });

  var orfaosAntigos = aberturas.filter(function(a){ return !a._used && a.ts < cutoff; });

  if (orfaosAntigos.length === 0) return { success: true, message: 'Nenhum órfão anterior a ' + cutoffStr + ' encontrado.', marcados: 0 };

  // Coluna N (índice 13) = OBSERVAÇÃO 2. Adiciona prefixo [LEGADO] se ainda não tiver.
  var colN = aba.getRange(1, 14, dados.length, 1).getValues();
  var marcados = 0;
  orfaosAntigos.forEach(function(o){
    var idx = o.row - 1; // base 0 no array colN (que começa na linha 1 da planilha)
    var atual = String(colN[idx][0] || '');
    if (!atual.includes('[LEGADO]')) {
      colN[idx][0] = '[LEGADO] ' + atual;
      marcados++;
    }
  });

  aba.getRange(1, 14, dados.length, 1).setValues(colN);
  return { success: true, message: marcados + ' órfão(s) anteriores a ' + cutoffStr + ' marcados como [LEGADO].', marcados: marcados };
}

// ================================================================
// LIMPAR REGISTROS DE TESTE — remove linhas com 'TESTE-AUTO' nas obs
// Execute via: ?action=limparTestes&key=AGF2026
// ================================================================
function limparRegistrosTeste() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return 0;
  const dados = aba.getDataRange().getValues();
  if (dados.length <= 1) return 0; // só cabeçalho

  const cabecalho = dados[0];
  const linhasValidas = [cabecalho]; // sempre mantém o cabeçalho
  let removidos = 0;

  // Estratégia eficiente: filtrar → limpar tudo → reescrever
  // Muito mais rápido que deleteRow() linha a linha
  for (let i = 1; i < dados.length; i++) {
    const obs1 = String(dados[i][7]  || '');
    const obs2 = String(dados[i][13] || '');
    const nome = String(dados[i][1]  || ''); // Col B — nome operador
    const isTest = obs1.includes('TESTE-AUTO') || obs2.includes('TESTE-AUTO')
                || obs1.includes('AUTOTESTE')  || obs2.includes('AUTOTESTE')
                || nome.includes('AUTOTESTE')
                || nome.includes('HUMANO')     // registros legados sem nome real
                || obs1.includes('CLEANUP')    || obs2.includes('CLEANUP');
    if (isTest) {
      removidos++;
    } else {
      linhasValidas.push(dados[i]);
    }
  }

  if (removidos === 0) return 0;

  // Limpar tudo e reescrever apenas as linhas válidas
  aba.clearContents();
  aba.getRange(1, 1, linhasValidas.length, cabecalho.length).setValues(linhasValidas);
  SpreadsheetApp.flush();

  Logger.log('🧹 Registros de teste removidos: ' + removidos + ' | Válidas mantidas: ' + (linhasValidas.length - 1));
  return removidos;
}

// ================================================================
// LIMPAR DADOS DO STRESS TEST — remove linhas cujo codItem é claramente
// sintético (TESTE-STRESS, TESTE-H1..H4, TESTE-I1, ITEM-ERRADO, X, etc.)
// das abas Respostas, Saldo_Parcial, Abertos e IdempotencyLog.
//
// Modo dry-run (padrão): retorna contagens sem apagar nada.
// Execute com dryRun=false para deletar de fato:
//   ?action=limparStressTest&key=AGF2026&dryRun=false
// ================================================================
const CODITEM_TESTE_ = new Set([
  'TESTE-STRESS', 'TESTE-DUP', 'TESTE-G5-SOLO',
  'TESTE-H1', 'TESTE-H2', 'TESTE-H3', 'TESTE-H4', 'TESTE-I1',
  'ITEM-ERRADO', 'X'
]);

// Wrappers sem argumentos para executar diretamente no editor GAS (sem deploy)
function _limparStressDryRun() { Logger.log(JSON.stringify(limparDadosStressTest(true),  null, 2)); }
function _limparStressExec()   { Logger.log(JSON.stringify(limparDadosStressTest(false), null, 2)); }

function limparDadosStressTest(dryRun) {
  dryRun = dryRun !== false; // padrão: dry-run
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const report = {
    success: true, dryRun: dryRun,
    respostas: 0, saldo: 0, abertos: 0, idempotency: 0,
    amostras: []
  };

  function _reescrever(aba, dados, validas, campo) {
    if (!dryRun && dados.length > validas.length) {
      aba.clearContents();
      aba.getRange(1, 1, validas.length, dados[0].length).setValues(validas);
      SpreadsheetApp.flush();
    }
  }

  // 1. Respostas — col E (índice 4) = CodItem
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  if (abaRe && abaRe.getLastRow() > 1) {
    const dados = abaRe.getDataRange().getValues();
    const validas = [dados[0]];
    for (let i = 1; i < dados.length; i++) {
      const cod = String(dados[i][COL_RE.COD_ITEM] || '').trim();
      if (CODITEM_TESTE_.has(cod)) {
        report.respostas++;
        if (report.amostras.length < 5)
          report.amostras.push('Respostas linha ' + (i+1) + ': ' + cod + ' / ' + String(dados[i][COL_RE.TIPO] || '') + ' / ' + String(dados[i][COL_RE.CARIMBO] || ''));
      } else {
        validas.push(dados[i]);
      }
    }
    _reescrever(abaRe, dados, validas, 'Respostas');
  }

  // 2. Saldo_Parcial — col B (índice 1) = CodItem
  const abaSaldo = ss.getSheetByName(ABA_SALDO);
  if (abaSaldo && abaSaldo.getLastRow() > 1) {
    const dados = abaSaldo.getDataRange().getValues();
    const validas = [dados[0]];
    for (let i = 1; i < dados.length; i++) {
      const cod = String(dados[i][1] || '').trim(); // índice 1 = CodItem
      if (CODITEM_TESTE_.has(cod)) {
        report.saldo++;
        if (report.amostras.length < 8)
          report.amostras.push('Saldo linha ' + (i+1) + ': ' + String(dados[i][0]||'') + ' / ' + cod + ' / qtd=' + dados[i][3]);
      } else {
        validas.push(dados[i]);
      }
    }
    _reescrever(abaSaldo, dados, validas, 'Saldo_Parcial');
  }

  // 3. Abertos — col F (índice 5 = COL_AB.COD_ITEM) = CodItem
  const abaAb = ss.getSheetByName(ABA_ABERTOS);
  if (abaAb && abaAb.getLastRow() > 1) {
    const dados = abaAb.getDataRange().getValues();
    const validas = [dados[0]];
    for (let i = 1; i < dados.length; i++) {
      const cod = String(dados[i][COL_AB.COD_ITEM] || '').trim();
      if (CODITEM_TESTE_.has(cod)) {
        report.abertos++;
        if (report.amostras.length < 11)
          report.amostras.push('Abertos linha ' + (i+1) + ': op=' + String(dados[i][COL_AB.OPERADOR]||'') + ' / ' + cod + ' / id=' + String(dados[i][COL_AB.ABERTO_ID]||''));
      } else {
        validas.push(dados[i]);
      }
    }
    _reescrever(abaAb, dados, validas, 'Abertos');
  }

  // 4. IdempotencyLog — col B (índice 1) = responseJson (contém o codItem no payload)
  const abaLog = ss.getSheetByName(ABA_IDEMPOTENCY);
  if (abaLog && abaLog.getLastRow() > 1) {
    const dados = abaLog.getDataRange().getValues();
    const validas = [dados[0]];
    for (let i = 1; i < dados.length; i++) {
      const resp = String(dados[i][1] || '');
      const isTest = resp.includes('TESTE-STRESS') || resp.includes('TESTE-DUP') ||
                     resp.includes('TESTE-G5')    || resp.includes('TESTE-H')   ||
                     resp.includes('TESTE-I1')    || resp.includes('ITEM-ERRADO');
      if (isTest) {
        report.idempotency++;
      } else {
        validas.push(dados[i]);
      }
    }
    _reescrever(abaLog, dados, validas, 'IdempotencyLog');
  }

  report.totalLinhas = report.respostas + report.saldo + report.abertos + report.idempotency;
  report.message = dryRun
    ? 'DRY-RUN: ' + report.totalLinhas + ' linha(s) seriam removidas. Confirme com dryRun=false.'
    : report.totalLinhas + ' linha(s) de teste removidas com sucesso.';
  return report;
}

// ================================================================
// REMOVER REGISTRO POR ABERTOid — deleta linha em Respostas (col P)
// e remove da aba Abertos (col 12). Usado para limpar registros
// de teste que não têm marcador AUTOTESTE.
// Execute via: ?action=removerRegistroPorId&key=AGF2026&id=AP-XXXXXX
// ================================================================
function removerRegistroPorAbertoId(idAlvo) {
  // Bug fix (concorrência): esta função fazia deleteRow sem nenhum lock — se rodasse ao
  // mesmo tempo que gravarApontamento/editarApontamento (que seguram o lock global), os
  // índices de linha lidos por uma operação podiam ficar inválidos pela outra, corrompendo
  // a linha errada. Agora usa o mesmo LockService das demais operações de escrita.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return { success: false, message: 'Servidor ocupado. Tente novamente em instantes.' };
  }
  try {
    const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
    const abaRe   = ss.getSheetByName(ABA_RESPOSTAS);
    const abaHist = ss.getSheetByName(ABA_HISTORICO); // arquivamento — o registro pode já ter sido movido pra cá
    const abaAb   = garantirAbaAbertos(ss);
    if (abaRe) removerFiltroSeExistir(abaRe);
    if (abaAb) removerFiltroSeExistir(abaAb);
    // Bug fix: ao remover FECHAMENTOs, o Saldo_Parcial daquela chave (série+item+operação)
    // fica órfão com um valor desatualizado se não for recalculado depois da remoção.
    const chavesSaldoParaRecalcular = [];

    // Perf fix: antes fazia clearContents() + reescrevia TODAS as linhas válidas de volta —
    // custoso numa planilha com milhares de linhas pra remover só 1-8. Usa deleteRows()
    // direcionado nas linhas que batem, de baixo pra cima (evita deslocamento de índice).
    // Varre a aba dada (Respostas OU Historico) e devolve as linhas restantes (com cabeçalho),
    // reaproveitadas no recálculo de saldo abaixo — evita uma segunda leitura completa.
    function removerDeAba(aba) {
      if (!aba) return { restantes: [[]], removidos: 0 };
      const dados = aba.getDataRange().getValues();
      const linhasParaRemover = [];
      const restantes = [dados[0]];
      for (let i = 1; i < dados.length; i++) {
        if (String(dados[i][15] || '').trim() === idAlvo) {
          linhasParaRemover.push(i + 1); // linha na planilha (1-indexed)
          if (String(dados[i][2] || '').trim() === 'FECHAMENTO') {
            chavesSaldoParaRecalcular.push({
              nrSerie:  String(dados[i][5] || '').split('|')[0].trim(),
              codItem:  String(dados[i][4] || '').trim(),
              operacao: String(dados[i][3] || '').substring(0, 4),
            });
          }
        } else {
          restantes.push(dados[i]);
        }
      }
      for (let k = linhasParaRemover.length - 1; k >= 0; k--) aba.deleteRow(linhasParaRemover[k]);
      return { restantes, removidos: linhasParaRemover.length };
    }

    const resRe   = removerDeAba(abaRe);
    const resHist = removerDeAba(abaHist);
    const removidosRe   = resRe.removidos;
    const removidosHist = resHist.removidos;

    // Estado pós-remoção mesclado (Historico + Respostas, ordem cronológica) — pra recálculo
    // de saldo correto mesmo se a linha removida já estava arquivada.
    const dadosRePosRemocao = [resRe.restantes[0] || resHist.restantes[0] || []]
      .concat(resHist.restantes.slice(1))
      .concat(resRe.restantes.slice(1));

    // Remove de Abertos (col 12 = índice 12)
    let removidosAb = 0;
    if (abaAb) {
      const dadosAb = abaAb.getDataRange().getValues();
      for (let i = dadosAb.length - 1; i >= 1; i--) {
        if (String(dadosAb[i][12] || '').trim() === idAlvo) {
          abaAb.deleteRow(i + 1);
          removidosAb++;
        }
      }
    }

    SpreadsheetApp.flush();
    if (removidosAb > 0) invalidarCacheAbertos(); // Opção A: invalida o cache curto se Abertos mudou

    // Recalcula Saldo_Parcial (do zero, replay) para cada chave afetada pelos FECHAMENTOs removidos.
    // Passa dadosRePosRemocao (já em memória, já mesclado e sem as linhas removidas).
    chavesSaldoParaRecalcular.forEach(c => {
      if (c.nrSerie && c.codItem) recalcularSaldoParcial(c.nrSerie, c.codItem, c.operacao, dadosRePosRemocao);
    });

    return {
      removidosRespostas: removidosRe,
      removidosHistorico: removidosHist,
      removidosAbertos: removidosAb,
      saldoRecalculado: chavesSaldoParaRecalcular.length > 0,
      mensagem: `ID ${idAlvo}: ${removidosRe} linha(s) removida(s) de Respostas, ${removidosHist} de ${ABA_HISTORICO}, ${removidosAb} de Abertos.`
    };
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// REMOVER POR CARIMBO + CÓDIGO DO ITEM — limpeza de registros de teste que não
// têm abertoId para usar removerRegistroPorAbertoId (ex.: fechamentos de lote
// gravados antes do fix do elo de pareamento, com Coluna 16 vazia).
// Execute via: ?action=removerPorCarimboECodItem&key=AGF2026&carimbo=...&codItem=...
// ================================================================
function removerRegistroPorCarimboECodItem(carimbo, codItem) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  function removerDeAba(aba) {
    if (!aba) return 0;
    let n = 0;
    const dados = aba.getDataRange().getValues();
    for (let i = dados.length - 1; i >= 1; i--) {
      const carimboLinha = dados[i][0] instanceof Date
        ? Utilities.formatDate(dados[i][0], 'GMT-3', 'dd/MM/yyyy HH:mm:ss')
        : String(dados[i][0] || '');
      if (carimboLinha === carimbo && String(dados[i][4] || '') === codItem) {
        aba.deleteRow(i + 1);
        n++;
      }
    }
    return n;
  }

  // Registro-alvo pode já ter sido arquivado — procura nas duas abas.
  const removidosRe   = removerDeAba(ss.getSheetByName(ABA_RESPOSTAS));
  const removidosHist = removerDeAba(ss.getSheetByName(ABA_HISTORICO));
  const removidos = removidosRe + removidosHist;
  SpreadsheetApp.flush();
  return { removidos, removidosRespostas: removidosRe, removidosHistorico: removidosHist,
    mensagem: `${removidos} linha(s) removida(s) com carimbo "${carimbo}" e codItem "${codItem}".` };
}

// ================================================================
// EDITAR APONTAMENTO — edita um registro específico (uma linha de Respostas),
// sincroniza a aba Abertos (se ainda em aberto) e recalcula Saldo_Parcial (se
// o registro editado for um FECHAMENTO ou afetar a chave de saldo).
//
// Identificação do registro: abertoId + tipoAlvo + nrSerieAlvo. Isso é necessário
// porque um abertoId pode ter várias linhas (lote: N séries × ABERTURA/FECHAMENTO).
//
// payload: {
//   action: 'editarApontamento', key: 'AGF2026',
//   abertoId, tipoAlvo, nrSerieAlvo,
//   novosValores: { carimbo, operador, operadorNome, tipo, operacao, codItem,
//                    nrSerie, implemento, cliente, quantidade, qtdPlanejada,
//                    obs1, obs2, retrabalho, numRNC, parada, opRetrabalho, setup }
// }
//
// LIMITAÇÃO INTENCIONAL: alterar `tipo` é uma sobrescrita direta — não revalida
// compatibilidade com o resto do par/lote. Use com cuidado.
// ================================================================
function editarApontamento(payload) {
  if (!_adminAutorizado(payload.key)) return jsonResponse({ success: false, message: 'Não autorizado.' });

  // Perf: 20s (era 15s) — mesma margem aplicada em gravarApontamento, ver comentário lá.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return jsonResponse({ success: false, message: 'Servidor ocupado. Tente novamente em instantes.' });
  }
  try {
    const abertoId    = String(payload.abertoId || '').trim();
    const tipoAlvo     = payload.tipoAlvo || '';
    const nrSerieAlvo  = String(payload.nrSerieAlvo || '').trim();
    const nv           = payload.novosValores || {};

    if (!abertoId) return jsonResponse({ success: false, message: 'abertoId é obrigatório.' });
    if (!TIPOS_APONTAMENTO[tipoAlvo]) return jsonResponse({ success: false, message: 'tipoAlvo inválido: "' + tipoAlvo + '".' });

    const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
    const abaRe   = ss.getSheetByName(ABA_RESPOSTAS);
    const abaHist = ss.getSheetByName(ABA_HISTORICO); // arquivamento — o registro pode já estar aqui
    if (!abaRe) return jsonResponse({ success: false, message: 'Aba "' + ABA_RESPOSTAS + '" não encontrada.' });

    const tipoFormatadoAlvo = TIPOS_APONTAMENTO[tipoAlvo];
    // Procura primeiro na aba viva, depois no Historico — ferramenta de correção admin
    // explicitamente pode mirar num registro antigo já arquivado.
    function localizarLinha(aba) {
      if (!aba) return null;
      const dados = aba.getDataRange().getValues();
      for (let i = 1; i < dados.length; i++) {
        if (String(dados[i][COL_RE.ABERTO_ID] || '').trim() !== abertoId) continue;
        if (String(dados[i][COL_RE.TIPO] || '').trim() !== tipoFormatadoAlvo) continue;
        const serieLinha = String(dados[i][COL_RE.SERIE] || '').split('|')[0].trim();
        if (serieLinha !== nrSerieAlvo) continue;
        return { aba, dados, linhaIdx: i };
      }
      return null;
    }
    const alvo = localizarLinha(abaRe) || localizarLinha(abaHist);
    if (!alvo) {
      return jsonResponse({ success: false, message: 'Registro não encontrado (abertoId/tipo/série não correspondem a nenhuma linha).' });
    }
    // abaAlvo/dadosRe/linhaIdx a partir daqui sempre se referem à aba ONDE O REGISTRO FOI
    // ACHADO (viva ou Historico) — mantém a checagem de duplicidade abaixo e a escrita no
    // mesmo universo consistente (um lote arquivado tem todas as suas linhas juntas na
    // mesma aba, nunca espalhadas).
    const abaAlvo = alvo.aba;
    const dadosRe = alvo.dados;
    const linhaIdx = alvo.linhaIdx;

    const linhaAntiga = [...dadosRe[linhaIdx]];
    const tiposAbertura = ['ABERTURA', 'INICIO_RETRABALHO', 'INICIO_PARADA'];

    const opAntiga    = String(linhaAntiga[COL_RE.OPERACAO] || '').substring(0, 4);
    const itemAntigo  = String(linhaAntiga[COL_RE.COD_ITEM] || '').trim();
    const serieAntiga = String(linhaAntiga[COL_RE.SERIE] || '').split('|')[0].trim();

    // ---------------------------------------------------------------
    // Localiza a linha correspondente em Abertos (se o registro ainda está aberto)
    // ---------------------------------------------------------------
    const abaAb = garantirAbaAbertos(ss);
    const dadosAbertos = abaAb.getDataRange().getValues();
    let linhaAbertosIdx = -1;
    for (let i = 1; i < dadosAbertos.length; i++) {
      if (String(dadosAbertos[i][COL_AB.ABERTO_ID] || '').trim() === abertoId) { linhaAbertosIdx = i; break; }
    }
    const estaAberto = linhaAbertosIdx !== -1;

    // ---------------------------------------------------------------
    // VALIDAÇÕES
    // ---------------------------------------------------------------
    // 1) Mudança de operador num registro de abertura ainda em aberto: não pode
    //    colidir com outro apontamento já aberto desse novo operador.
    if (nv.operador !== undefined && tiposAbertura.includes(tipoAlvo) && estaAberto) {
      const novoOperadorNorm = normalizarCodigoOp(nv.operador);
      const operadorAtualAbertos = String(dadosAbertos[linhaAbertosIdx][COL_AB.OPERADOR] || '');
      if (!mesmoOperador(novoOperadorNorm, operadorAtualAbertos)) {
        for (let i = 1; i < dadosAbertos.length; i++) {
          if (i === linhaAbertosIdx) continue;
          if (!dadosAbertos[i][COL_AB.OPERADOR]) continue;
          if (mesmoOperador(dadosAbertos[i][COL_AB.OPERADOR], novoOperadorNorm)) {
            return jsonResponse({ success: false, message: 'O operador informado já possui outro apontamento em aberto.' });
          }
        }
      }
    }

    // 2) Mudança de série: valida caractere proibido, duplicidade dentro do mesmo
    //    abertoId/tipo (mesmo lote) e existência no cadastro.
    if (nv.nrSerie !== undefined && String(nv.nrSerie).trim() !== serieAntiga) {
      const novaSerieNorm = String(nv.nrSerie).trim();
      if (novaSerieNorm.includes('|')) {
        return jsonResponse({ success: false, message: 'Campo nrSerie não pode conter o caractere "|".' });
      }
      for (let i = 1; i < dadosRe.length; i++) {
        if (i === linhaIdx) continue;
        if (String(dadosRe[i][COL_RE.ABERTO_ID] || '').trim() !== abertoId) continue;
        if (String(dadosRe[i][COL_RE.TIPO] || '').trim() !== tipoFormatadoAlvo) continue;
        const outraSerie = String(dadosRe[i][COL_RE.SERIE] || '').split('|')[0].trim();
        if (outraSerie === novaSerieNorm) {
          return jsonResponse({ success: false, message: 'Já existe outra série igual a "' + novaSerieNorm + '" neste mesmo apontamento.' });
        }
      }
      if (novaSerieNorm) {
        const abaSeries = ss.getSheetByName(ABA_SERIES);
        if (abaSeries) {
          const seriesData = abaSeries.getDataRange().getValues().slice(1);
          const seriesValidas = new Set(
            seriesData.filter(r => String(r[3]).toUpperCase() !== 'NÃO' && r[0] !== '').map(r => String(r[0]).trim())
          );
          if (!seriesValidas.has(novaSerieNorm)) {
            return jsonResponse({ success: false, message: 'Série "' + novaSerieNorm + '" não encontrada no cadastro.' });
          }
        }
      }
    }

    // 3) Validações de valor numérico
    if (nv.quantidade !== undefined && nv.quantidade !== '' && nv.quantidade !== null) {
      const q = Number(nv.quantidade);
      if (isNaN(q) || q < 0) return jsonResponse({ success: false, message: 'Quantidade inválida.' });
    }
    if (nv.qtdPlanejada !== undefined && nv.qtdPlanejada !== '' && nv.qtdPlanejada !== null) {
      const qp = Number(nv.qtdPlanejada);
      if (isNaN(qp) || qp < 0) return jsonResponse({ success: false, message: 'Quantidade planejada inválida.' });
    }

    // ---------------------------------------------------------------
    // APLICA EDIÇÕES — Respostas
    // ---------------------------------------------------------------
    const linhaNova = [...linhaAntiga];
    if (nv.carimbo !== undefined)      linhaNova[COL_RE.CARIMBO] = nv.carimbo;
    if (nv.operadorNome !== undefined) linhaNova[COL_RE.OPERADOR] = nv.operadorNome;
    if (nv.tipo !== undefined)         linhaNova[COL_RE.TIPO] = TIPOS_APONTAMENTO[nv.tipo] || nv.tipo;
    if (nv.operacao !== undefined)     linhaNova[COL_RE.OPERACAO] = OPERACOES[nv.operacao] || nv.operacao;
    if (nv.codItem !== undefined)      linhaNova[COL_RE.COD_ITEM] = nv.codItem;
    if (nv.nrSerie !== undefined || nv.implemento !== undefined || nv.cliente !== undefined) {
      const partesAntigas = String(linhaAntiga[COL_RE.SERIE] || '').split('|').map(s => s.trim());
      const nrS  = nv.nrSerie    !== undefined ? String(nv.nrSerie).trim()    : (partesAntigas[0] || '');
      const impl = nv.implemento !== undefined ? String(nv.implemento).trim() : (partesAntigas[1] || '');
      const cli  = nv.cliente    !== undefined ? String(nv.cliente).trim()    : (partesAntigas[2] || '');
      linhaNova[COL_RE.SERIE] = nrS ? (nrS + ' | ' + impl + ' | ' + cli) : impl;
    }
    if (nv.quantidade !== undefined)    linhaNova[COL_RE.QTD] = nv.quantidade === '' ? '' : Number(nv.quantidade);
    if (nv.obs1 !== undefined)          linhaNova[COL_RE.OBS1] = nv.obs1;
    if (nv.retrabalho !== undefined)    linhaNova[COL_RE.TIPO_RETRAB] = nv.retrabalho;
    if (nv.numRNC !== undefined)        linhaNova[COL_RE.NR_RNC] = nv.numRNC;
    if (nv.parada !== undefined)        linhaNova[COL_RE.TIPO_PARADA] = nv.parada;
    if (nv.opRetrabalho !== undefined)  linhaNova[COL_RE.OPERACAO2] = OPERACOES[nv.opRetrabalho] || nv.opRetrabalho;
    if (nv.setup !== undefined)         linhaNova[COL_RE.TIPO_SETUP] = nv.setup;
    if (nv.obs2 !== undefined)          linhaNova[COL_RE.OBS2] = nv.obs2;
    if (nv.qtdPlanejada !== undefined)  linhaNova[COL_RE.QTD_PLANEJADA] = nv.qtdPlanejada === '' ? '' : Number(nv.qtdPlanejada);

    abaAlvo.getRange(linhaIdx + 1, 1, 1, linhaNova.length).setValues([linhaNova]);
    // Reflete a edição na cópia em memória — reaproveitada no recálculo de saldo abaixo,
    // evitando uma releitura completa da planilha que acabamos de escrever.
    dadosRe[linhaIdx] = linhaNova;

    // ---------------------------------------------------------------
    // SINCRONIZA Abertos (se o registro ainda está aberto)
    // ---------------------------------------------------------------
    let abertosSincronizado = false;
    if (estaAberto) {
      const rowAb = [...dadosAbertos[linhaAbertosIdx]];
      const loteRaw = String(rowAb[COL_AB.LOTE_SERIES] || '').trim();

      if (loteRaw) {
        let seriesArr = [];
        try { seriesArr = JSON.parse(loteRaw); } catch (e) {}
        const idxSerie = seriesArr.findIndex(s => String(s.nrSerie).trim() === nrSerieAlvo);
        if (idxSerie !== -1) {
          if (nv.nrSerie !== undefined)     seriesArr[idxSerie].nrSerie = String(nv.nrSerie).trim();
          if (nv.implemento !== undefined)  seriesArr[idxSerie].implemento = nv.implemento;
          if (nv.cliente !== undefined)     seriesArr[idxSerie].cliente = nv.cliente;
          if (nv.qtdPlanejada !== undefined) seriesArr[idxSerie].qtdPlanejada = Number(nv.qtdPlanejada) || 0;
          rowAb[COL_AB.LOTE_SERIES] = JSON.stringify(seriesArr);
          rowAb[COL_AB.QTD_PLANEJADA] = seriesArr.reduce((s, x) => s + (Number(x.qtdPlanejada) || 0), 0);
        }
      } else {
        if (nv.nrSerie !== undefined)     { rowAb[COL_AB.NR_SERIE] = nv.nrSerie; }
        if (nv.implemento !== undefined)   rowAb[COL_AB.IMPLEMENTO_NOME] = nv.implemento;
        if (nv.cliente !== undefined)      rowAb[COL_AB.CLIENTE] = nv.cliente;
        if (nv.qtdPlanejada !== undefined) rowAb[COL_AB.QTD_PLANEJADA] = nv.qtdPlanejada;
      }
      if (nv.operador !== undefined)     rowAb[COL_AB.OPERADOR] = normalizarCodigoOp(nv.operador);
      if (nv.operadorNome !== undefined) rowAb[COL_AB.OPERADOR_NOME] = nv.operadorNome;
      if (nv.operacao !== undefined)     rowAb[COL_AB.OPERACAO] = OPERACOES[nv.operacao] || nv.operacao;
      if (nv.codItem !== undefined)      rowAb[COL_AB.COD_ITEM] = nv.codItem;
      if (nv.carimbo !== undefined)      rowAb[COL_AB.CARIMBO] = nv.carimbo;

      abaAb.getRange(linhaAbertosIdx + 1, 1, 1, rowAb.length).setValues([rowAb]);
      abertosSincronizado = true;
    }

    SpreadsheetApp.flush();
    if (abertosSincronizado) invalidarCacheAbertos(); // Opção A: invalida o cache curto se Abertos mudou

    // ---------------------------------------------------------------
    // RECALCULA Saldo_Parcial (só se o registro editado for um FECHAMENTO)
    // ---------------------------------------------------------------
    let saldoRecalculado = false;
    if (tipoFormatadoAlvo === 'FECHAMENTO') {
      const opNova    = nv.operacao !== undefined ? String(nv.operacao).substring(0, 4) : opAntiga;
      const itemNovo  = nv.codItem  !== undefined ? String(nv.codItem).trim() : itemAntigo;
      const serieNova = nv.nrSerie  !== undefined ? String(nv.nrSerie).trim() : serieAntiga;

      // Leitura mesclada (viva + Historico) — o registro editado pode ter sido um FECHAMENTO
      // já arquivado; sem isso o replay da chave ficaria incompleto (só veria a aba viva).
      // Já refletimos o flush acima, então esta leitura já enxerga a edição aplicada.
      const dadosParaReplay = _lerRespostasComHistorico(ss);
      recalcularSaldoParcial(serieAntiga, itemAntigo, opAntiga, dadosParaReplay);
      if (serieNova !== serieAntiga || itemNovo !== itemAntigo || opNova !== opAntiga) {
        recalcularSaldoParcial(serieNova, itemNovo, opNova, dadosParaReplay);
      }
      saldoRecalculado = true;
    }

    return jsonResponse({
      success: true,
      message: 'Apontamento atualizado.',
      abertosSincronizado: abertosSincronizado,
      saldoRecalculado: saldoRecalculado,
    });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// REMOVER REGISTROS SEM TIMESTAMP — deleta linhas onde col A está vazia.
// Usa deleteRow de baixo para cima (evita deslocamento de índices).
// NÃO usa clearContents — opera célula a célula para máxima segurança.
// Execute via: ?action=removerSemTimestamp&key=AGF2026
// ================================================================
function removerRegistrosSemTimestamp() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba não encontrada.' };

  const dados = aba.getDataRange().getValues();
  const totalAntes = dados.length - 1; // exclui cabeçalho

  // Coleta linhas a deletar (de cima para baixo, mas deleta de baixo para cima)
  const linhasParaDeletar = [];
  for (let i = 1; i < dados.length; i++) {
    const colA = dados[i][0];
    const vazio = (!colA) ||
      (colA instanceof Date && colA.getFullYear() <= 1900) ||
      (typeof colA === 'string' && colA.trim() === '');
    if (vazio) {
      linhasParaDeletar.push(i + 1); // número real da linha na planilha (1-indexed)
    }
  }

  // Deleta de baixo para cima para não deslocar índices
  for (let k = linhasParaDeletar.length - 1; k >= 0; k--) {
    aba.deleteRow(linhasParaDeletar[k]);
  }

  if (linhasParaDeletar.length > 0) SpreadsheetApp.flush();

  // Verifica o estado final
  const totalDepois = aba.getLastRow() - 1; // exclui cabeçalho

  return {
    success: true,
    removidos: linhasParaDeletar.length,
    totalAntes,
    totalDepois,
    mensagem: linhasParaDeletar.length + ' registro(s) sem timestamp removido(s). ' +
              totalDepois + ' registros válidos mantidos.'
  };
}

// ================================================================
// REVERTER TIMESTAMPS INTERPOLADOS — desfaz o preencherTimestampsVazios
// Remove timestamps que são idênticos ao registro imediatamente anterior
// (padrão característico de interpolação). Restaura a célula para vazio.
// Execute via: ?action=reverterTimestamps&key=AGF2026
// ================================================================
function reverterTimestampsInterpolados() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba não encontrada.' };

  const dados = aba.getDataRange().getValues();
  let revertidos = 0;
  const updates = []; // { row (1-indexed) }

  for (let i = 1; i < dados.length; i++) {
    const colA = dados[i][0];
    const colAPrev = dados[i - 1][0];
    if (!colA || !colAPrev) continue;

    // Converte para string para comparação
    let tsAtual = '', tsPrev = '';
    if (colA instanceof Date)    tsAtual = Utilities.formatDate(colA,    'GMT-3', 'dd/MM/yyyy HH:mm:ss');
    else if (typeof colA === 'string') tsAtual = colA.trim();
    if (colAPrev instanceof Date)  tsPrev  = Utilities.formatDate(colAPrev, 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
    else if (typeof colAPrev === 'string') tsPrev = colAPrev.trim();

    if (tsAtual && tsPrev && tsAtual === tsPrev) {
      updates.push({ row: i + 1 });
      revertidos++;
    }
  }

  // Limpa os timestamps interpolados (seta célula para string vazia)
  for (const upd of updates) {
    aba.getRange(upd.row, 1).setValue('');
  }
  if (revertidos > 0) SpreadsheetApp.flush();

  return {
    success: true,
    revertidos,
    mensagem: revertidos + ' timestamp(s) interpolado(s) removido(s). Células voltaram para vazio.'
  };
}

// ================================================================
// PREENCHER TIMESTAMPS VAZIOS — interpolação pelo registro anterior
// Preenche col A vazia com o timestamp do último registro com data.
// Registros sem vizinho anterior são deixados em branco.
// Execute via: ?action=preencherTimestamps&key=AGF2026
// ================================================================
function preencherTimestampsVazios() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  const dados = aba.getDataRange().getValues();
  let ultimoTs = null;
  let preenchidos = 0;
  const updates = []; // { row (1-indexed), ts }

  for (let i = 1; i < dados.length; i++) {
    const colA = dados[i][0];
    // Verifica se há timestamp válido nesta célula
    let tsStr = '';
    if (colA instanceof Date && colA.getFullYear() > 1900) {
      tsStr = Utilities.formatDate(colA, 'GMT-3', 'dd/MM/yyyy HH:mm:ss');
    } else if (typeof colA === 'string' && colA.trim()) {
      tsStr = colA.trim();
    }

    if (tsStr) {
      ultimoTs = tsStr;
    } else if (ultimoTs) {
      // Célula vazia — preenche com o último timestamp conhecido
      updates.push({ row: i + 1, ts: ultimoTs }); // +1 porque dados[0] é header (linha 1)
      preenchidos++;
    }
  }

  // Aplica os updates linha a linha
  // (não usa setValues em batch pois as linhas não são contíguas)
  for (const upd of updates) {
    aba.getRange(upd.row, 1).setValue(upd.ts);
  }

  if (preenchidos > 0) SpreadsheetApp.flush();

  return {
    success: true,
    preenchidos,
    mensagem: preenchidos + ' timestamp(s) preenchido(s) por interpolação do registro anterior.'
  };
}

// ================================================================
// LISTAR REVISÕES DA PLANILHA — via Drive REST API (UrlFetchApp)
// Não requer re-autorização do DriveApp service.
// Execute via: ?action=listarRevisoes&key=AGF2026
// ================================================================
function listarRevisoesPlanilha() {
  // Usa Drive Advanced Service (já autorizado junto com o scope drive)
  const lista = [];
  let pageToken = '';
  do {
    const params = { fields: 'revisions(id,modifiedTime,lastModifyingUser/emailAddress),nextPageToken', pageSize: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const resp = Drive.Revisions.list(SPREADSHEET_ID, params);
    (resp.revisions || []).forEach(r => lista.push({
      id: r.id,
      data: r.modifiedTime ? Utilities.formatDate(new Date(r.modifiedTime), 'GMT-3', 'dd/MM/yyyy HH:mm:ss') : '',
      autor: (r.lastModifyingUser || {}).emailAddress || 'desconhecido'
    }));
    pageToken = resp.nextPageToken || '';
  } while (pageToken);

  lista.reverse(); // mais recentes primeiro
  return { success: true, total: lista.length, ultimas30: lista.slice(0, 30) };
}

// ================================================================
// RECUPERAR TIMESTAMPS DE UMA REVISÃO — exporta a revisão como CSV
// e extrai a coluna A (timestamps) mapeando pelo ID da col P
// Execute via: ?action=recuperarTimestamps&key=AGF2026&revId=XXX
// ================================================================
function recuperarTimestampsDaRevisao(revId) {
  const token = ScriptApp.getOAuthToken();
  const headers = { Authorization: 'Bearer ' + token };

  // Verifica se a revisão existe via Drive REST API
  const revUrl = 'https://www.googleapis.com/drive/v3/files/' + SPREADSHEET_ID + '/revisions/' + revId +
    '?fields=id,modifiedTime';
  const revResp = UrlFetchApp.fetch(revUrl, { headers, muteHttpExceptions: true });
  if (revResp.getResponseCode() !== 200) {
    return { success: false, message: 'Revisão ' + revId + ' não encontrada. HTTP ' + revResp.getResponseCode() };
  }
  const revInfo = JSON.parse(revResp.getContentText());
  const dataRevisao = revInfo.modifiedTime ?
    Utilities.formatDate(new Date(revInfo.modifiedTime), 'GMT-3', 'dd/MM/yyyy HH:mm:ss') : '?';
  // (revAlvo substituído por revInfo/dataRevisao acima — nada a verificar aqui)

  // Exporta a revisão como CSV (primeira aba)
  const exportUrl = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID +
    '/export?format=csv&gid=971425155&revision=' + revId;
  const options = {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  const resp = UrlFetchApp.fetch(exportUrl, options);
  if (resp.getResponseCode() !== 200) {
    return { success: false, message: 'Erro ao exportar revisão: HTTP ' + resp.getResponseCode() };
  }

  // Parseia o CSV linha a linha
  const csv = resp.getContentText();
  const linhas = Utilities.parseCsv(csv);
  if (linhas.length < 2) return { success: false, message: 'Revisão vazia.' };

  // Mapeia: abertoId (col P = index 15) → timestamp (col A = index 0)
  const mapa = {};
  let comTimestamp = 0;
  for (let i = 1; i < linhas.length; i++) {
    const row = linhas[i];
    const ts = String(row[0] || '').trim();
    const id = String(row[15] || '').trim();
    if (ts && id) {
      mapa[id] = ts;
      comTimestamp++;
    }
  }

  return {
    success: true,
    revisao: revId,
    dataRevisao: dataRevisao,
    totalLinhas: linhas.length - 1,
    comTimestamp,
    amostra: Object.entries(mapa).slice(0, 5).map(([id, ts]) => ({ id, ts }))
  };
}

// ================================================================
// APLICAR TIMESTAMPS RECUPERADOS — preenche col A vazia usando
// o mapa de abertoId→timestamp de uma revisão anterior
// Execute via: ?action=aplicarTimestamps&key=AGF2026&revId=XXX
// ================================================================
function aplicarTimestampsDaRevisao(revId) {
  // 1. Obtém o mapa da revisão
  const mapaResult = recuperarTimestampsDaRevisao(revId);
  if (!mapaResult.success) return mapaResult;

  // Reconstrói o mapa a partir do CSV da revisão
  const tokenApp2 = ScriptApp.getOAuthToken();
  const exportUrl = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID +
    '/export?format=csv&gid=971425155&revision=' + revId;
  const options = { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  const csv = UrlFetchApp.fetch(exportUrl, options).getContentText();
  const linhas = Utilities.parseCsv(csv);
  const mapa = {};
  for (let i = 1; i < linhas.length; i++) {
    const ts = String(linhas[i][0] || '').trim();
    const id = String(linhas[i][15] || '').trim();
    if (ts && id) mapa[id] = ts;
  }

  // 2. Lê Respostas atual e preenche timestamps vazios
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  const dados = aba.getDataRange().getValues();
  let preenchidos = 0;
  const updates = []; // [row, timestamp]

  for (let i = 1; i < dados.length; i++) {
    const tsAtual = String(dados[i][0] || '').trim();
    if (tsAtual) continue; // já tem timestamp
    const id = String(dados[i][15] || '').trim();
    if (id && mapa[id]) {
      updates.push({ row: i + 1, ts: mapa[id] });
      preenchidos++;
    }
  }

  // Aplica os updates em batch
  for (const upd of updates) {
    aba.getRange(upd.row, 1).setValue(upd.ts);
  }
  if (updates.length > 0) SpreadsheetApp.flush();

  return {
    success: true,
    revisaoUsada: revId,
    preenchidos,
    mensagem: preenchidos + ' timestamp(s) recuperado(s) da revisão ' + revId
  };
}

// ================================================================
// ANÁLISE DE INCONSISTÊNCIAS — replica a lógica da aba "Inconsistências"
// do dashboard AGRICEF para identificação server-side
// Execute via: ?action=analisarInconsistencias&key=AGF2026
// ================================================================
function analisarInconsistencias() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  // Auditoria de histórico completo — inclui Historico (arquivamento), não só a aba viva.
  const dados = _lerRespostasComHistorico(ss);
  if (dados.length < 2) return { success: false, message: 'Sem dados.' };

  // ── PARSE REGISTROS ──────────────────────────────────────────
  // Usa lerLinhaRespostas + parseCarimboGsMs para evitar bug MM/DD do V8 do GAS.
  // Inclui abertoId (col P) para pareamento exato na Fase 1.
  const records = [];
  for (let i = 1; i < dados.length; i++) {
    const r = lerLinhaRespostas(dados[i]);
    if (!r.operador || !r.tipo) continue;
    const tsMs = parseCarimboGsMs(r.carimbo);
    if (!tsMs || isNaN(tsMs)) continue;
    records.push({
      tsMs,
      func:     r.operador,
      tipo:     r.tipo,
      op:       r.operacao,
      item:     r.codItem,
      serie:    r.nrSerie,
      abertoId: r.abertoId,
    });
  }

  // Ordena por timestamp
  records.sort((a, b) => a.tsMs - b.tsMs);

  // ── WORK MINUTES (seg-sex 08:00-17:00, pausa 12:00-13:00) ──
  function workMinutes(tsStart, tsEnd) {
    if (tsEnd <= tsStart) return 0;
    const WS = 480, WE = 1020, LS = 720, LE = 780;
    function mid(ms) { const d = new Date(ms); return d.getHours()*60 + d.getMinutes(); }
    function wmd(s, e) {
      s = Math.max(s, WS); e = Math.min(e, WE);
      if (e <= s) return 0;
      return e - s - Math.max(0, Math.min(e, LE) - Math.max(s, LS));
    }
    function isWD(ms) { const d = new Date(ms); return d.getDay() >= 1 && d.getDay() <= 5; }
    function nextWDStart(ms) {
      const d = new Date(ms);
      d.setHours(8, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      while (new Date(d).getDay() < 1 || new Date(d).getDay() > 5) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    let tot = 0, cur = tsStart, it = 0;
    const mCur = mid(cur);
    if (!isWD(cur) || mCur >= WE) { cur = nextWDStart(cur); }
    else if (mCur < WS) { const d = new Date(cur); d.setHours(8, 0, 0, 0); cur = d.getTime(); }
    while (cur < tsEnd && it++ < 500) {
      if (!isWD(cur)) { cur = nextWDStart(cur); continue; }
      const eod = new Date(cur); eod.setHours(17, 0, 0, 0);
      tot += wmd(mid(cur), mid(tsEnd < eod.getTime() ? tsEnd : eod.getTime()));
      cur = nextWDStart(cur);
    }
    return Math.max(0, tot);
  }

  // ── PAIR ROWS ─────────────────────────────────────────────────
  // Fase 1: par exato por abertoId (se ambos tiverem o mesmo abertoId não-vazio)
  // Fase 2: fuzzy (mesmo operador + maior score por op/serie/item)
  // Sem filtro de duração máxima — operações multi-dia são válidas.
  function pairRows(rows, openType, closeType) {
    const pairs = [];
    const opens = [];
    rows.forEach(r => {
      if (r.tipo === openType) {
        opens.push({ ...r, _used: false });
      } else if (r.tipo === closeType) {
        let best = null, bestScore = -1;

        // Tolerância de 5 min: resolve lotes onde FECHAMENTO foi gravado segundos antes da ABERTURA
        const TOLERANCIA_MS = 5 * 60 * 1000;

        // Fase 1 — abertoId exato (se disponível)
        if (r.abertoId) {
          for (let i = 0; i < opens.length; i++) {
            const o = opens[i];
            if (o._used || o.func !== r.func || o.tsMs > r.tsMs + TOLERANCIA_MS) continue;
            if (o.abertoId && o.abertoId === r.abertoId) { best = i; bestScore = 99; break; }
          }
        }

        // Fase 2 — fuzzy (fallback se abertoId não casou)
        if (best === null) {
          for (let i = 0; i < opens.length; i++) {
            const o = opens[i];
            if (o._used || o.func !== r.func || o.tsMs > r.tsMs + TOLERANCIA_MS) continue;
            let score = 1;
            if (o.op    === r.op)    score += 4;
            if (o.serie === r.serie) score += 2;
            if (o.item  === r.item)  score += 1;
            if (score > bestScore) { bestScore = score; best = i; }
          }
        }

        if (best !== null) {
          const o = opens[best];
          // Negativo → 0: lotes onde FECHAMENTO chega segundos antes da ABERTURA (clock drift)
          const dur = Math.max(0, workMinutes(o.tsMs, r.tsMs));
          pairs.push({ func: r.func, op: r.op || o.op, serie: r.serie || o.serie,
            item: r.item || o.item, dur, openTs: o.tsMs, closeTs: r.tsMs });
          opens[best]._used = true;
        }
      }
    });
    return pairs;
  }

  // ── CHECK 1: ABERTURAs sem FECHAMENTO ─────────────────────────
  const pairsAudit = pairRows(records, 'ABERTURA', 'FECHAMENTO');
  const pairedOpenKeys = new Set(pairsAudit.map(p => p.func + '||' + p.openTs));
  const backlog = records.filter(r =>
    r.tipo === 'ABERTURA' && !pairedOpenKeys.has(r.func + '||' + r.tsMs)
  );

  // ── CHECK 2: Durações suspeitas (> 10h work ou < 1 min work) ──
  const allPairs = [
    ...pairRows(records, 'ABERTURA', 'FECHAMENTO'),
    ...pairRows(records, 'INÍCIO DE PARADA', 'TÉRMINO DE PARADA'),
    ...pairRows(records, 'INÍCIO DE RETRABALHO', 'TÉRMINO DE RETRABALHO'),
  ];
  const tooLong  = allPairs.filter(p => p.dur > 600);
  const tooShort = allPairs.filter(p => p.dur > 0 && p.dur < 1);

  // ── CHECK 3: Apontamentos simultâneos (< 2 min entre ABERTURAs, ops distintas) ──
  const aberturas = records.filter(r => r.tipo === 'ABERTURA').sort((a, b) => a.tsMs - b.tsMs);
  const byFunc = {};
  aberturas.forEach(r => { if (!byFunc[r.func]) byFunc[r.func] = []; byFunc[r.func].push(r); });
  const simultaneos = [];
  Object.entries(byFunc).forEach(([func, recs]) => {
    for (let i = 0; i < recs.length - 1; i++) {
      const a = recs[i], b = recs[i+1];
      const diffMin = (b.tsMs - a.tsMs) / 60000;
      if (diffMin < 2 && a.op !== b.op) {
        simultaneos.push({ func, tsA: a.tsMs, tsB: b.tsMs, opA: a.op, opB: b.op });
      }
    }
  });

  // ── CHECK 4: FECHAMENTOs sem ABERTURA ────────────────────────
  const pairedCloseKeys = new Set(pairsAudit.map(p => p.func + '||' + p.closeTs));
  const orphanClose = records.filter(r =>
    r.tipo === 'FECHAMENTO' && !pairedCloseKeys.has(r.func + '||' + r.tsMs)
  );

  // ── TOTAIS ──────────────────────────────────────────────────
  const total = backlog.length + tooLong.length + tooShort.length + simultaneos.length + orphanClose.length;

  function fmtTs(ms) {
    return Utilities.formatDate(new Date(ms), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm');
  }

  return {
    success: true,
    totalRegistros: records.length,
    totalPares: pairsAudit.length,
    totalInconsistencias: total,
    aberturaSemFechamento: {
      count: backlog.length, sev: 'alta',
      exemplos: backlog.slice(0, 15).map(r => ({
        func: r.func, op: r.op, serie: r.serie, ts: fmtTs(r.tsMs)
      }))
    },
    fechamentoSemAbertura: {
      count: orphanClose.length, sev: 'baixa',
      exemplos: orphanClose.slice(0, 15).map(r => ({
        func: r.func, op: r.op, ts: fmtTs(r.tsMs)
      }))
    },
    duracaoLonga: {
      count: tooLong.length, sev: 'media',
      exemplos: tooLong.slice(0, 10).map(p => ({
        func: p.func, op: p.op, durMin: Math.round(p.dur),
        de: fmtTs(p.openTs), ate: fmtTs(p.closeTs)
      }))
    },
    duracaoCurta: {
      count: tooShort.length, sev: 'baixa',
      exemplos: tooShort.slice(0, 10).map(p => ({
        func: p.func, op: p.op, durSeg: Math.round(p.dur * 60),
        ts: fmtTs(p.openTs)
      }))
    },
    simultaneos: {
      count: simultaneos.length, sev: 'media',
      exemplos: simultaneos.slice(0, 10).map(s => ({
        func: s.func, opA: s.opA, opB: s.opB,
        tsA: fmtTs(s.tsA), tsB: fmtTs(s.tsB)
      }))
    }
  };
}

// ── Placeholder functions referenciadas em doGet ──────────────────────────────
function analisarOrfaos() {
  return analisarInconsistencias();
}

// ================================================================
// EXCLUIR FECHAMENTOS ÓRFÃOS — remove FECHAMENTOs sem ABERTURA par
// Execute via: ?action=excluirFechamentosOrfaos&key=AGF2026&dryRun=true
// dryRun=true  → apenas lista o que seria excluído (padrão)
// dryRun=false → excluí efetivamente (irreversível)
// ================================================================
// Como _lerRespostasComHistorico, mas cada linha retornada sabe de qual aba (e qual número de
// linha real nela) veio — necessário pra ferramentas que precisam DELETAR por posição real, não
// só ler. Um FECHAMENTO órfão pode ter sido arquivado antes de alguém notar que era órfão (o
// arquivamento não valida pareamento fuzzy, só a regra de saldo por chave) — precisa saber em
// qual aba deletar.
function _lerRespostasComHistoricoRastreado(ss) {
  const abaRe   = ss.getSheetByName(ABA_RESPOSTAS);
  const dadosRe = abaRe ? abaRe.getDataRange().getValues() : [[]];
  const abaHist = ss.getSheetByName(ABA_HISTORICO);
  const dadosHist = (abaHist && abaHist.getLastRow() >= 2) ? abaHist.getDataRange().getValues() : null;

  const linhas = [];
  if (dadosHist) {
    for (let i = 1; i < dadosHist.length; i++) linhas.push({ row: dadosHist[i], aba: abaHist, sheetRow: i + 1 });
  }
  for (let i = 1; i < dadosRe.length; i++) linhas.push({ row: dadosRe[i], aba: abaRe, sheetRow: i + 1 });
  return linhas;
}

function excluirFechamentosOrfaos(dryRun) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // Auditoria de histórico completo (viva + Historico) — filtro idêntico ao
  // analisarInconsistencias: exige operador E tipo preenchidos.
  const records = [];
  _lerRespostasComHistoricoRastreado(ss).forEach(({ row, aba, sheetRow }) => {
    const r = lerLinhaRespostas(row);
    if (!r.operador || !r.tipo) return;
    const tsMs = parseCarimboGsMs(r.carimbo);
    if (!tsMs || isNaN(tsMs)) return;
    records.push({
      tipo: r.tipo, func: r.operador, op: r.operacao,
      serie: r.nrSerie, item: r.codItem, tsMs,
      abertoId: r.abertoId,
      aba, sheetRow,
      id: records.length, // identidade única no conjunto combinado (duas abas têm "linha 5" cada)
    });
  });

  // Algoritmo de pareamento idêntico ao analisarInconsistencias
  const TOLERANCIA_MS = 5 * 60 * 1000;
  const opens = [];
  const pairs = [];

  records.forEach(r => {
    if (r.tipo === 'ABERTURA') {
      opens.push({ ...r, _used: false });
    } else if (r.tipo === 'FECHAMENTO') {
      let best = null, bestScore = -1;

      // Fase 1 — abertoId exato
      if (r.abertoId) {
        for (let i = 0; i < opens.length; i++) {
          const o = opens[i];
          if (o._used || o.func !== r.func || o.tsMs > r.tsMs + TOLERANCIA_MS) continue;
          if (o.abertoId && o.abertoId === r.abertoId) { best = i; bestScore = 99; break; }
        }
      }
      // Fase 2 — fuzzy
      if (best === null) {
        for (let i = 0; i < opens.length; i++) {
          const o = opens[i];
          if (o._used || o.func !== r.func || o.tsMs > r.tsMs + TOLERANCIA_MS) continue;
          let score = 1;
          if (o.op    === r.op)    score += 4;
          if (o.serie === r.serie) score += 2;
          if (o.item  === r.item)  score += 1;
          if (score > bestScore) { bestScore = score; best = i; }
        }
      }

      if (best !== null) {
        opens[best]._used = true;
        pairs.push({ fechId: r.id, aberId: opens[best].id });
      }
      // Se best === null: FECHAMENTO é órfão — será marcado abaixo
    }
  });

  const pairedCloseIds = new Set(pairs.map(p => p.fechId));
  const orfaos = records.filter(r => r.tipo === 'FECHAMENTO' && !pairedCloseIds.has(r.id));

  if (dryRun) {
    return {
      success: true, dryRun: true,
      total: orfaos.length,
      registros: orfaos.map(r => ({
        row: r.sheetRow, aba: r.aba.getName(),
        func: r.func, op: r.op,
        ts: Utilities.formatDate(new Date(r.tsMs), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm')
      }))
    };
  }

  // Execução: apaga de baixo pra cima, DENTRO DE CADA ABA separadamente — cada aba tem sua
  // própria numeração de linha, misturar índices entre abas corromperia a linha errada.
  const porAba = {};
  orfaos.forEach(r => {
    const nome = r.aba.getName();
    if (!porAba[nome]) porAba[nome] = { aba: r.aba, linhas: [] };
    porAba[nome].linhas.push(r.sheetRow);
  });
  let totalExcluidas = 0;
  Object.keys(porAba).forEach(nome => {
    const { aba, linhas } = porAba[nome];
    linhas.sort((a, b) => b - a).forEach(row => aba.deleteRow(row));
    totalExcluidas += linhas.length;
  });

  return {
    success: true, dryRun: false,
    linhasExcluidas: totalExcluidas,
    mensagem: totalExcluidas + ' FECHAMENTOs órfãos excluídos.'
  };
}

// ================================================================
// EXCLUIR ABERTURAS ÓRFÃS — remove ABERTURAs sem FECHAMENTO par
// Execute via: ?action=excluirAberturasOrfas&key=AGF2026&dryRun=true
// dryRun=true  → apenas lista (padrão)
// dryRun=false → exclui efetivamente (irreversível)
// ================================================================
function excluirAberturasOrfas(dryRun) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(ABA_RESPOSTAS);
  const data  = sheet.getDataRange().getValues();

  const records = [];
  for (let i = 1; i < data.length; i++) {
    const r = lerLinhaRespostas(data[i]);
    if (!r.operador || !r.tipo) continue;
    const tsMs = parseCarimboGsMs(r.carimbo);
    if (!tsMs || isNaN(tsMs)) continue;
    records.push({
      tipo: r.tipo, func: r.operador, op: r.operacao,
      serie: r.nrSerie, item: r.codItem, tsMs,
      abertoId: r.abertoId,
      rowIndex: i + 1
    });
  }

  const TOLERANCIA_MS = 5 * 60 * 1000;
  const opens = [];
  const pairedOpenRows = new Set();

  records.forEach(r => {
    if (r.tipo === 'ABERTURA') {
      opens.push({ ...r, _used: false });
    } else if (r.tipo === 'FECHAMENTO') {
      let best = null, bestScore = -1;

      if (r.abertoId) {
        for (let i = 0; i < opens.length; i++) {
          const o = opens[i];
          if (o._used || o.func !== r.func || o.tsMs > r.tsMs + TOLERANCIA_MS) continue;
          if (o.abertoId && o.abertoId === r.abertoId) { best = i; bestScore = 99; break; }
        }
      }
      if (best === null) {
        for (let i = 0; i < opens.length; i++) {
          const o = opens[i];
          if (o._used || o.func !== r.func || o.tsMs > r.tsMs + TOLERANCIA_MS) continue;
          let score = 1;
          if (o.op    === r.op)    score += 4;
          if (o.serie === r.serie) score += 2;
          if (o.item  === r.item)  score += 1;
          if (score > bestScore) { bestScore = score; best = i; }
        }
      }

      if (best !== null) {
        opens[best]._used = true;
        pairedOpenRows.add(opens[best].rowIndex);
      }
    }
  });

  const orfaos = records.filter(r =>
    r.tipo === 'ABERTURA' && !pairedOpenRows.has(r.rowIndex)
  );

  if (dryRun) {
    return {
      success: true, dryRun: true,
      total: orfaos.length,
      registros: orfaos.map(r => ({
        row: r.rowIndex,
        func: r.func, op: r.op,
        ts: Utilities.formatDate(new Date(r.tsMs), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm')
      }))
    };
  }

  const rowsDesc = orfaos.map(r => r.rowIndex).sort((a, b) => b - a);
  rowsDesc.forEach(row => sheet.deleteRow(row));

  return {
    success: true, dryRun: false,
    linhasExcluidas: rowsDesc.length,
    mensagem: rowsDesc.length + ' ABERTURAs órfãs excluídas.'
  };
}

// ================================================================
// SMOKE TEST — verifica integridade das funções críticas após deploy
// Execute via: ?action=smokeTest&key=AGF2026
// Retorna { success, erros[], timestamp } — erros vazio = tudo OK
// ================================================================
function smokeTest() {
  const erros = [];

  // ── 1. formatarCarimboGs: testa os 4 formatos de entrada ──
  const casosFmt = [
    { entrada: new Date('2026-06-10T18:00:00Z'), esperado: /^\d{2}\/\d{2}\/2026\s\d{2}:\d{2}:\d{2}$/ },
    { entrada: '10/06/2026 15:52:02',            esperado: /^10\/06\/2026/ },
    { entrada: '2026-06-10T18:52:00.000Z',       esperado: /^10\/06\/2026/ },
    { entrada: 'Tue Jun 10 2026 15:55:28 GMT-0300 (Brasilia Standard Time)',
                                                 esperado: /^10\/06\/2026/ },
  ];
  casosFmt.forEach(c => {
    const r = formatarCarimboGs(c.entrada);
    if (!c.esperado.test(r))
      erros.push('formatarCarimboGs falhou: entrada="' + c.entrada + '" → "' + r + '"');
  });

  // ── 2. parseCarimboGsMs: converte dd/MM/yyyy sem bug MM/DD ──
  const ms1 = parseCarimboGsMs('09/06/2026 15:52:00');
  const d1  = new Date(ms1);
  if (d1.getDate() !== 9 || d1.getMonth() !== 5)   // junho = mês 5 (0-indexed)
    erros.push('parseCarimboGsMs: 09/06 interpretado como mês 9 (bug MM/DD) — d=' + d1.getDate() + ' m=' + (d1.getMonth()+1));

  const ms2 = parseCarimboGsMs('01/06/2026 08:00:00');
  const d2  = new Date(ms2);
  if (d2.getDate() !== 1 || d2.getMonth() !== 5)
    erros.push('parseCarimboGsMs: 01/06 falhou — d=' + d2.getDate() + ' m=' + (d2.getMonth()+1));

  // ── 3. mesmoOperador: normaliza zeros à esquerda ──
  if (!mesmoOperador('000130', '130'))  erros.push('mesmoOperador: 000130 ≠ 130 (deve ser igual)');
  if (!mesmoOperador('130', '130'))     erros.push('mesmoOperador: 130 ≠ 130');
  if ( mesmoOperador('130', '131'))     erros.push('mesmoOperador: 130 = 131 (falso positivo)');
  if ( mesmoOperador('', '130'))        erros.push('mesmoOperador: "" = 130 (falso positivo)');

  // ── 4. lerLinhaRespostas: mapeamento de campos ──
  const linhaFake = new Array(16).fill('');
  linhaFake[COL_RE.OPERADOR]    = '130';
  linhaFake[COL_RE.TIPO]        = 'ABERTURA';
  linhaFake[COL_RE.OPERACAO]    = '0040';
  linhaFake[COL_RE.COD_ITEM]    = 'ITEM01';
  linhaFake[COL_RE.SERIE]       = '1001 | IMPLEMENTO_X | CLIENTE_Y';
  linhaFake[COL_RE.QTD_PLANEJADA] = 5;
  linhaFake[COL_RE.ABERTO_ID]   = 'AP-ABCD1234EF';
  const lLRe = lerLinhaRespostas(linhaFake);
  if (lLRe.operador    !== '130')          erros.push('lerLinhaRespostas: operador errado → ' + lLRe.operador);
  if (lLRe.tipo        !== 'ABERTURA')     erros.push('lerLinhaRespostas: tipo errado → ' + lLRe.tipo);
  if (lLRe.nrSerie     !== '1001')         erros.push('lerLinhaRespostas: nrSerie errado → ' + lLRe.nrSerie);
  if (lLRe.implemento  !== 'IMPLEMENTO_X') erros.push('lerLinhaRespostas: implemento errado → ' + lLRe.implemento);
  if (lLRe.abertoId    !== 'AP-ABCD1234EF') erros.push('lerLinhaRespostas: abertoId errado → ' + lLRe.abertoId);
  if (lLRe.qtdPlanejada !== 5)             erros.push('lerLinhaRespostas: qtdPlanejada errado → ' + lLRe.qtdPlanejada);

  // ── 5. lerLinhaAbertos: mapeamento de campos ──
  const linhaAb = new Array(13).fill('');
  linhaAb[COL_AB.OPERADOR]    = '130';
  linhaAb[COL_AB.ABERTO_ID]  = 'AP-TEST000001';
  linhaAb[COL_AB.CLIENTE]    = 'CLIENTE_Z';
  const lLAb = lerLinhaAbertos(linhaAb);
  if (lLAb.operador  !== '130')          erros.push('lerLinhaAbertos: operador errado → ' + lLAb.operador);
  if (lLAb.abertoId  !== 'AP-TEST000001') erros.push('lerLinhaAbertos: abertoId errado → ' + lLAb.abertoId);
  if (lLAb.cliente   !== 'CLIENTE_Z')    erros.push('lerLinhaAbertos: cliente errado → ' + lLAb.cliente);

  return {
    success: erros.length === 0,
    erros:   erros,
    timestamp: Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm:ss'),
    versao: 'v4.3.7',
  };
}

function marcarOrfaosLegado(cutoff) {
  return { success: false, message: 'Função não implementada. Use analisarInconsistencias.' };
}

// ================================================================
// FORCE MATCH ÓRFÃOS
// 1. Roda o algoritmo completo de pareamento (Phase1 abertoId + Phase2 fuzzy)
//    para identificar os registros que REALMENTE não foram pareados.
// 2. Tenta casar os órfãos com critério relaxado:
//    mesmo operador + mesma operação + ts_FECHAMENTO >= ts_ABERTURA - 5min
//    (ignora série — resolve lotes de março/2026)
// 3. Para pares encontrados: escreve o abertoId da ABERTURA em col P do FECHAMENTO.
//    Se a ABERTURA também não tiver abertoId, gera um novo para ambos.
// 4. Para órfãos sem par: exclui da planilha.
//
// Execute via: ?action=forceMatchOrfaos&key=AGF2026&dryRun=true   (simulação)
//              ?action=forceMatchOrfaos&key=AGF2026               (executa)
// Parâmetro: cutoff=2026-06-08 (só processa registros ANTES desta data)
// ================================================================
function forceMatchOrfaos(dryRun, cutoffDateStr) {
  dryRun = (dryRun === true || dryRun === 'true');
  cutoffDateStr = cutoffDateStr || '2026-06-08';
  const cutoffMs = new Date(cutoffDateStr + 'T00:00:00').getTime();

  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  const dados = aba.getDataRange().getValues();

  // ── PASSO 1: lê TODOS os registros com índice de linha ─────────
  const allRecs = [];
  for (let i = 1; i < dados.length; i++) {
    const r = lerLinhaRespostas(dados[i]);
    if (!r.operador || !r.tipo) continue;
    const tsMs = parseCarimboGsMs(r.carimbo);
    if (!tsMs || isNaN(tsMs)) continue;
    if (tsMs >= cutoffMs) continue;  // só antes do cutoff
    allRecs.push({
      rowIndex: i + 1, tsMs,
      operador: r.operador, tipo: r.tipo, operacao: r.operacao,
      serie: r.nrSerie, codItem: r.codItem, carimbo: r.carimbo,
      abertoId: r.abertoId, _used: false,
    });
  }
  allRecs.sort((a, b) => a.tsMs - b.tsMs);

  // ── PASSO 2: algoritmo normal (Phase1+Phase2) — marca os pareados ─
  const aberturas  = allRecs.filter(r => r.tipo === 'ABERTURA');
  const fechamentos = allRecs.filter(r => r.tipo === 'FECHAMENTO');

  fechamentos.forEach(c => {
    let best = null, bestScore = -1;
    // Phase 1 — abertoId exato
    if (c.abertoId) {
      for (let i = 0; i < aberturas.length; i++) {
        const o = aberturas[i];
        if (o._used || !mesmoOperador(o.operador, c.operador)) continue;
        if (o.tsMs > c.tsMs + 5*60000) continue;
        if (o.abertoId && o.abertoId === c.abertoId) { best = i; bestScore = 99; break; }
      }
    }
    // Phase 2 — fuzzy
    if (best === null) {
      for (let i = 0; i < aberturas.length; i++) {
        const o = aberturas[i];
        if (o._used || !mesmoOperador(o.operador, c.operador)) continue;
        if (o.tsMs > c.tsMs + 5*60000) continue;
        let score = 1;
        if (o.operacao === c.operacao) score += 4;
        if (o.serie    === c.serie)    score += 2;
        if (o.codItem  === c.codItem)  score += 1;
        if (score > bestScore) { bestScore = score; best = i; }
      }
    }
    if (best !== null) {
      aberturas[best]._used = true;
      c._used = true;
    }
  });

  // ── PASSO 3: identifica órfãos reais ──────────────────────────
  const orphanAb  = aberturas.filter(r => !r._used);   // ABERTURAs não pareadas
  const orphanFe  = fechamentos.filter(r => !r._used); // FECHAMENTOs não pareados

  // Reset para o force-match
  orphanAb.forEach(r => r._used = false);
  orphanFe.forEach(r => r._used = false);

  // ── PASSO 4: force-match com critério relaxado ──────────────────
  // Mesmo operador + mesma operação + FECHAMENTO >= ABERTURA - 5min
  // Desempate: menor diferença de tempo
  const pares = [];

  orphanFe.forEach(c => {
    let bestIdx = -1, bestDelta = Infinity;

    for (let i = 0; i < orphanAb.length; i++) {
      const o = orphanAb[i];
      if (o._used) continue;
      if (!mesmoOperador(o.operador, c.operador)) continue;
      if (o.operacao !== c.operacao) continue;        // mesma operação obrigatória
      if (o.tsMs > c.tsMs + 5 * 60000) continue;     // ABERTURA não pode ser muito depois do FECHAMENTO

      const delta = Math.abs(c.tsMs - o.tsMs);
      if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
    }

    if (bestIdx >= 0) {
      const o = orphanAb[bestIdx];
      o._used = true;
      c._used = true;
      // Usa abertoId da ABERTURA; se não tiver, gera novo para ambos
      const idFinal = o.abertoId || gerarIdApontamento();
      pares.push({
        idFinal,
        openRow:   o.rowIndex,
        closeRow:  c.rowIndex,
        openHasId: !!o.abertoId,
        operador:  o.operador,
        operacao:  o.operacao,
        serieAb:   o.serie,
        serieFe:   c.serie,
        tsAb:      o.carimbo,
        tsFe:      c.carimbo,
        deltaMin:  Math.round((c.tsMs - o.tsMs) / 60000),
      });
    }
  });

  // ── PASSO 5: registros sem par algum → excluir ─────────────────
  const semParAb = orphanAb.filter(r => !r._used);
  const semParFe = orphanFe.filter(r => !r._used);
  const linhasExcluir = semParAb.map(r => r.rowIndex)
    .concat(semParFe.map(r => r.rowIndex))
    .sort((a, b) => b - a); // decrescente para não deslocar índices

  const log = {
    success:       true,
    dryRun,
    cutoff:        cutoffDateStr,
    totalAntes:    { aberturas: aberturas.length, fechamentos: fechamentos.length },
    orfaosEncontrados: { aberturas: orphanAb.length, fechamentos: orphanFe.length },
    forcePareados: pares.length,
    semParExcluir: { aberturas: semParAb.length, fechamentos: semParFe.length },
    linhasExcluidas: linhasExcluir.length,
    exemplosPares: pares.slice(0, 20).map(p => ({
      operador: p.operador, operacao: p.operacao,
      tsAb: p.tsAb, serieAb: p.serieAb,
      tsFe: p.tsFe, serieFe: p.serieFe,
      delta: p.deltaMin + 'min',
    })),
    exemplosExcluidos: semParAb.slice(0, 10).map(r => ({
      row: r.rowIndex, operador: r.operador, operacao: r.operacao,
      serie: r.serie, ts: r.carimbo,
    })),
  };

  if (dryRun) return log;

  // ── EXECUÇÃO ──────────────────────────────────────────────────
  // 1. Escreve o id no FECHAMENTO (e na ABERTURA se estava sem id)
  pares.forEach(p => {
    aba.getRange(p.closeRow, COL_RE.ABERTO_ID + 1).setValue(p.idFinal);
    if (!p.openHasId) {
      aba.getRange(p.openRow, COL_RE.ABERTO_ID + 1).setValue(p.idFinal);
    }
  });

  // 2. Exclui linhas sem par (decrescente para não deslocar índices)
  linhasExcluir.forEach(row => {
    try { aba.deleteRow(row); } catch(e) {}
  });

  // 3. Reconstrói Abertos
  try { reconstruirAbertos(); } catch(e) {}

  log.mensagem = pares.length + ' pares casados via force-match, ' + linhasExcluir.length + ' linhas sem par excluídas.';
  return log;
}

// ================================================================
// IMPACTO DA REMOÇÃO DE ÓRFÃOS — detalha os registros inconsistentes
// para avaliação antes de qualquer remoção
// Execute via: ?action=impactoOrfaos&key=AGF2026
// ================================================================
function impactoOrfaos() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  // Auditoria de histórico completo (tendência mensal desde o início) — inclui Historico.
  const dados = _lerRespostasComHistorico(ss);
  if (dados.length < 2) return { success: false, message: 'Sem dados.' };

  function fmtTs(ms) {
    return Utilities.formatDate(new Date(ms), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm');
  }

  // ── PARSE (igual a analisarInconsistencias) ──────────────────
  const records = [];
  for (let i = 1; i < dados.length; i++) {
    const row    = dados[i];
    const tsRaw  = row[0];
    const func   = String(row[1] || '').trim();
    const tipo   = String(row[2] || '').trim();
    const op     = String(row[3] || '').trim();
    const item   = String(row[4] || '').trim();
    const serie  = String(row[5] || '').trim().split(' | ')[0].trim();

    if (!func || !tipo) continue;

    let tsMs;
    if (tsRaw instanceof Date) tsMs = tsRaw.getTime();
    else if (tsRaw)            tsMs = new Date(String(tsRaw)).getTime();
    if (!tsMs || isNaN(tsMs))  continue;

    records.push({ tsMs, func, tipo, op, item, serie, sheetRow: i + 1 });
  }

  records.sort((a, b) => a.tsMs - b.tsMs);

  // ── PAIR ROWS ────────────────────────────────────────────────
  function pairRows(rows, openType, closeType) {
    const pairs = [];
    const opens = [];
    rows.forEach(r => {
      if (r.tipo === openType) {
        opens.push({ ...r, _used: false });
      } else if (r.tipo === closeType) {
        let best = null, bestScore = -1;
        for (let i = 0; i < opens.length; i++) {
          const o = opens[i];
          if (o._used || o.func !== r.func || o.tsMs > r.tsMs) continue;
          let score = 1;
          if (o.op    === r.op)    score += 4;
          if (o.serie === r.serie) score += 2;
          if (o.item  === r.item)  score += 1;
          if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best !== null) {
          const o = opens[best];
          const durRaw = (r.tsMs - o.tsMs) / 60000; // minutos reais (sem filtro workMinutes)
          if (durRaw > 0) {
            pairs.push({ func: r.func, op: r.op || o.op, serie: r.serie || o.serie,
              item: r.item || o.item, durRaw, openTs: o.tsMs, closeTs: r.tsMs });
          }
          opens[best]._used = true;
        }
      }
    });
    return pairs;
  }

  const pairsAudit = pairRows(records, 'ABERTURA', 'FECHAMENTO');
  const pairedOpenKeys  = new Set(pairsAudit.map(p => p.func + '||' + p.openTs));
  const pairedCloseKeys = new Set(pairsAudit.map(p => p.func + '||' + p.closeTs));

  const backlog     = records.filter(r => r.tipo === 'ABERTURA'   && !pairedOpenKeys.has(r.func  + '||' + r.tsMs));
  const orphanClose = records.filter(r => r.tipo === 'FECHAMENTO' && !pairedCloseKeys.has(r.func + '||' + r.tsMs));

  // ── AGRUPA POR FUNCIONÁRIO ──────────────────────────────────
  function agrupar(lista) {
    const m = {};
    lista.forEach(r => {
      if (!m[r.func]) m[r.func] = { func: r.func, count: 0, ops: new Set(), datas: [] };
      m[r.func].count++;
      if (r.op) m[r.func].ops.add(r.op);
      m[r.func].datas.push(r.tsMs);
    });
    return Object.values(m).map(v => ({
      func: v.func.split(' - ').slice(1).join(' ') || v.func,
      funcRaw: v.func,
      count: v.count,
      ops: [...v.ops].join(', '),
      primeiro: fmtTs(Math.min(...v.datas)),
      ultimo:   fmtTs(Math.max(...v.datas))
    })).sort((a, b) => b.count - a.count);
  }

  // ── DISTRIBUIÇÃO POR MÊS ────────────────────────────────────
  function porMes(lista) {
    const m = {};
    lista.forEach(r => {
      const mes = Utilities.formatDate(new Date(r.tsMs), 'America/Sao_Paulo', 'yyyy-MM');
      m[mes] = (m[mes] || 0) + 1;
    });
    return Object.entries(m).sort().map(([mes, cnt]) => ({ mes, cnt }));
  }

  // ── ESTIMATIVA DE HORAS PERDIDAS ─────────────────────────────
  // Para ABERTURAs órfãs: tentamos estimar duração pelo próximo FECHAMENTO do mesmo func
  // (mesmo que não pareado), para ter ideia do volume perdido
  let minutosPerdidosEstimados = 0;
  backlog.forEach(ab => {
    // Procura o FECHAMENTO mais próximo após esta ABERTURA para o mesmo funcionário
    const prox = orphanClose.find(fc => fc.func === ab.func && fc.tsMs > ab.tsMs);
    if (prox) {
      const d = (prox.tsMs - ab.tsMs) / 60000;
      if (d > 0 && d < 24 * 60) minutosPerdidosEstimados += d; // só conta se < 24h
    }
  });

  return {
    success: true,
    totalRegistros: records.length,
    totalOrfaos: backlog.length + orphanClose.length,
    pctDoTotal: ((backlog.length + orphanClose.length) / records.length * 100).toFixed(2) + '%',

    aberturaSemFechamento: {
      total: backlog.length,
      porFuncionario: agrupar(backlog),
      porMes: porMes(backlog),
      detalhes: backlog.map(r => ({
        func: r.func, op: r.op, serie: r.serie, item: r.item,
        ts: fmtTs(r.tsMs), sheetRow: r.sheetRow
      }))
    },

    fechamentoSemAbertura: {
      total: orphanClose.length,
      porFuncionario: agrupar(orphanClose),
      porMes: porMes(orphanClose),
      detalhes: orphanClose.map(r => ({
        func: r.func, op: r.op, serie: r.serie, item: r.item,
        ts: fmtTs(r.tsMs), sheetRow: r.sheetRow
      }))
    },

    impactoEstimado: {
      horasEstimadas: (minutosPerdidosEstimados / 60).toFixed(1),
      obs: 'Estimativa de horas de produção representadas pelos pares órfãos (ABERTURA+FECHAMENTO sem par entre si)'
    }
  };
}

// ================================================================
// PREVIEW / DELETAR ABERTURAS ÓRFÃS HISTÓRICAS
//
// Identifica ABERTURAs sem FECHAMENTO correspondente com timestamp
// até a data de corte (cutoff), e opcionalmente as remove.
//
// Preview:  ?action=previewAberturasOrfas&key=AGF2026&cutoff=2026-05-29
// Deletar:  ?action=deletarAberturasOrfas&key=AGF2026&cutoff=2026-05-29
//
// A lógica de emparelhamento usa durReal (minutos reais de relógio),
// idêntica à correção aplicada no dashboard (não usa workMinutes para
// validar o par, evitando falsos positivos em fins de semana).
// ================================================================

function previewAberturasOrfas(cutoffDateStr) {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  const dados = aba.getDataRange().getValues();
  if (dados.length < 2) return { success: false, message: 'Sem dados.' };

  // Cutoff: fim do dia da data informada
  const cutoff   = cutoffDateStr ? new Date(cutoffDateStr + 'T23:59:59') : new Date('2026-05-29T23:59:59');
  const cutoffMs = cutoff.getTime();

  // ── PARSER DE DATAS — suporta Date objects, formato BR (dd/MM/yyyy HH:mm:ss)
  //    e ISO. Garante que strings no formato brasileiro (saídas de getDadosRespostas)
  //    sejam corretamente interpretadas.
  function parseTs(val) {
    if (!val && val !== 0) return null;
    if (val instanceof Date) {
      const ms = val.getTime();
      return (!ms || isNaN(ms)) ? null : ms;
    }
    const s = String(val).trim();
    if (!s) return null;
    // Formato BR: dd/MM/yyyy HH:mm:ss  ou  dd/MM/yyyy, HH:mm:ss
    const brMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[,\s]+(\d{2}):(\d{2}):(\d{2})/);
    if (brMatch) {
      const [, dd, mm, yyyy, hh, min, sec] = brMatch;
      const ms = new Date(+yyyy, +mm - 1, +dd, +hh, +min, +sec).getTime();
      return isNaN(ms) ? null : ms;
    }
    // Fallback: ISO ou qualquer outro formato reconhecível
    const ms = new Date(s).getTime();
    return isNaN(ms) ? null : ms;
  }

  // ── PARSE — inclui todas as linhas com timestamp válido ─────────
  // Usa Utilities.formatDate para gerar a chave de timestamp no mesmo
  // formato que getDadosRespostas → alinhado com o algoritmo do dashboard.
  const records = [];
  for (let i = 1; i < dados.length; i++) {
    const row   = dados[i];
    const tsRaw = row[0];
    if (!tsRaw || (tsRaw instanceof Date && isNaN(tsRaw.getTime()))) continue;

    // Gera string canônica: "dd/MM/yyyy HH:mm:ss" em GMT-3 (igual a getData)
    let tsStr;
    if (tsRaw instanceof Date) {
      try { tsStr = Utilities.formatDate(tsRaw, 'GMT-3', 'dd/MM/yyyy HH:mm:ss'); }
      catch(e) { continue; }
    } else {
      tsStr = String(tsRaw).trim();
    }
    if (!tsStr) continue;

    // Converte para ms para comparação de datas (cutoff, ordenação)
    const tsMs = parseTs(tsRaw) || parseTs(tsStr);
    if (!tsMs) continue;

    const func  = String(row[1]  || '').trim();
    const tipo  = String(row[2]  || '').trim();
    // Coluna D (index 3) = TIPO DE OPERAÇÃO 1  |  Coluna L (index 11) = TIPO DE OPERAÇÃO 2
    // Dashboard usa: op = D || L  (mesmo fallback)
    const op    = (String(row[3]  || '').trim()) || (String(row[11] || '').trim());
    const item  = String(row[4]  || '').trim();
    const serie = String(row[5]  || '').trim().split(' | ')[0].trim();

    records.push({ sheetRow: i + 1, tsMs, tsStr, func, tipo, op, item, serie });
  }

  // Ordena cronologicamente (igual ao dashboard)
  records.sort((a, b) => a.tsMs - b.tsMs);

  // ── PAIR ROWS — réplica exata do dashboard ────────────────────────
  // Chave de identificação: func + '||' + tsStr  (mesmo formato da dashboard)
  function pairRows(rows, openType, closeType) {
    const opens = [];
    const pairedOpenKeys = new Set();  // chaves: func||tsStr
    rows.forEach(r => {
      if (r.tipo === openType) {
        opens.push({ ...r, _used: false });
      } else if (r.tipo === closeType) {
        let best = null, bestScore = -1;
        for (let i = 0; i < opens.length; i++) {
          const o = opens[i];
          if (o._used || o.func !== r.func || o.tsMs > r.tsMs) continue;
          let score = 1;
          if (o.op    === r.op)    score += 4;
          if (o.serie === r.serie) score += 2;
          if (o.item  === r.item)  score += 1;
          if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best !== null) {
          const o       = opens[best];
          const durReal = (r.tsMs - o.tsMs) / 60000;  // minutos reais de relógio
          if (durReal > 0 && durReal < 10080) {         // < 7 dias reais
            pairedOpenKeys.add(o.func + '||' + o.tsStr);
          }
          opens[best]._used = true;
        }
      }
    });
    return pairedOpenKeys;
  }

  const pairedOpenKeys = pairRows(records, 'ABERTURA', 'FECHAMENTO');

  // ── SELECIONA ÓRFÃS ATÉ O CUTOFF ─────────────────────────────────
  const orfas = records.filter(r =>
    r.tipo  === 'ABERTURA' &&
    r.func  !== ''          &&   // descarta linhas sem operador
    r.tsMs  <= cutoffMs     &&
    !pairedOpenKeys.has(r.func + '||' + r.tsStr)   // chave alinhada com dashboard
  );

  const fmtTs = ms => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  return {
    success:          true,
    cutoff:           cutoff.toLocaleDateString('pt-BR'),
    totalRegistros:   records.length,
    totalPares:       pairedOpenKeys.size,
    orfasEncontradas: orfas.length,
    items: orfas.map(r => ({
      sheetRow: r.sheetRow,
      ts:       r.tsStr,
      func:     r.func,
      op:       r.op,
      item:     r.item,
      serie:    r.serie
    }))
  };
}

function deletarAberturasOrfas(cutoffDateStr) {
  // 1. Identificar as linhas a deletar via preview
  const preview = previewAberturasOrfas(cutoffDateStr);
  if (!preview.success) return preview;
  if (preview.orfasEncontradas === 0) {
    return { success: true, removidos: 0, message: 'Nenhuma ABERTURA órfã encontrada até ' + (cutoffDateStr || '29/05/2026') + '.' };
  }

  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  // 2. Ordena de baixo para cima para não deslocar índices durante a deleção
  const linhas = preview.items.map(r => r.sheetRow).sort((a, b) => b - a);

  for (const linha of linhas) {
    aba.deleteRow(linha);
  }
  SpreadsheetApp.flush();

  // 3. Reconstrói a aba Abertos para refletir o estado atual
  let recResult = null;
  try { recResult = reconstruirAbertos(); } catch(e) { recResult = { error: e.message }; }

  return {
    success:         true,
    removidos:       linhas.length,
    linhasDeletadas: [...linhas].reverse(), // ordem crescente p/ leitura
    reconstruirAbertos: recResult,
    message:         linhas.length + ' ABERTURA(s) órfã(s) removida(s). Aba Abertos reconstruída.'
  };
}

// ================================================================
// LOCALIZAR LINHAS POR IDENTIFICADORES (func + ts)
//
// Recebe uma lista de {func, ts} vindos do algoritmo do dashboard
// (executado no browser via getData) e localiza os números de linha
// exatos na planilha Respostas, para deleção segura.
//
// Chamada via POST com payload:
//   { action: 'localizarLinhas', key: 'AGF2026',
//     identifiers: [{func, ts}, ...], deletar: false }
//
// ts deve estar no formato 'dd/MM/yyyy HH:mm:ss' (sem vírgula),
// igual ao produzido por getDadosRespostas / Utilities.formatDate.
// ================================================================

// ================================================================
// Fix#ID-LINK — MIGRAÇÃO HISTÓRICA DE IDs
//
// Recebe lista de {sheetRow, abertoId} e escreve o abertoId na
// coluna P (col 16) de cada linha especificada da aba Respostas.
//
// Usado APENAS UMA VEZ para linkar registros históricos.
// Operação idempotente: se col P já tem o mesmo ID, não faz nada.
// ================================================================
function migrarIdsHistoricos(updates) {
  if (!updates || updates.length === 0) {
    return { success: false, message: 'Lista de updates vazia.' };
  }
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  const lastRow = aba.getLastRow();
  if (lastRow < 2) return { success: false, message: 'Aba sem dados.' };

  // Leitura em bulk: toda a coluna P de uma vez (muito mais rápido que célula a célula)
  const numDataRows = lastRow - 1; // linha 1 = cabeçalho
  const colPRange   = aba.getRange(2, 16, numDataRows, 1);
  const colPValues  = colPRange.getValues(); // [[val], [val], ...]

  let atualizados = 0, ignorados = 0, erros = [], dirty = false;

  for (const upd of updates) {
    const row = parseInt(upd.sheetRow);
    const id  = String(upd.abertoId || '').trim();
    if (!row || row < 2 || row > lastRow || !id) {
      erros.push('Linha inválida ou ID vazio: ' + JSON.stringify(upd));
      continue;
    }
    const idx   = row - 2; // 0-indexed no array
    const atual = String(colPValues[idx][0] || '').trim();
    if (atual === id) { ignorados++; continue; } // idempotente: já correto
    colPValues[idx][0] = id;
    atualizados++;
    dirty = true;
  }

  // Escrita em bulk: uma única chamada para toda a coluna
  if (dirty) {
    colPRange.setValues(colPValues);
    SpreadsheetApp.flush();
  }

  return {
    success: true,
    total: updates.length,
    atualizados,
    ignorados,
    erros: erros.length > 0 ? erros : undefined,
    message: atualizados + ' linha(s) atualizadas, ' + ignorados + ' já corretas.',
  };
}

// ================================================================
// BACKFILL DE ABERTOID — INÍCIO/TÉRMINO DE PARADA E RETRABALHO ANTIGOS
//
// O Fix#ID-LINK que grava abertoId em INÍCIO/TÉRMINO DE PARADA e RETRABALHO só entrou em
// vigor a partir de determinada data — registros anteriores a isso ficaram com a coluna P
// vazia. Diferente do ABERTURA/FECHAMENTO (que já foi corrigido antes, ver migrarIdsHistoricos),
// esses dois tipos nunca passaram por um backfill equivalente.
//
// Pareia por OPERADOR, em ordem cronológica, alternando início/término — não usa série/item
// porque paradas/retrabalhos antigos frequentemente não têm esses campos preenchidos. Cada
// família (parada, retrabalho) é pareada separadamente, nunca cruza uma com a outra. Eventos
// que sobram sem par (início sem término, ou vice-versa) são relatados, não recebem ID —
// mais seguro deixar sem ID do que arriscar um pareamento errado.
// ================================================================
function _calcularBackfillIdsParadaRetrabalho(dadosRe) {
  const FAMILIAS = [
    { inicio: 'INÍCIO DE PARADA', termino: 'TÉRMINO DE PARADA' },
    { inicio: 'INÍCIO DE RETRABALHO', termino: 'TÉRMINO DE RETRABALHO' },
  ];

  const atualizacoes = []; // {sheetRow, abertoId}
  const semPar = [];       // eventos sem par encontrado — relatados, não escritos

  FAMILIAS.forEach(fam => {
    const porOperador = {};
    for (let i = 1; i < dadosRe.length; i++) {
      const row = dadosRe[i];
      const tipo = String(row[COL_RE.TIPO] || '').trim();
      if (tipo !== fam.inicio && tipo !== fam.termino) continue;
      if (String(row[COL_RE.ABERTO_ID] || '').trim()) continue; // já tem ID, não mexe
      const op = String(row[COL_RE.OPERADOR] || '').trim();
      if (!porOperador[op]) porOperador[op] = [];
      porOperador[op].push({ sheetRow: i + 1, tipo, ms: _carimboArquivamentoMs(row[COL_RE.CARIMBO]) });
    }

    Object.keys(porOperador).forEach(op => {
      const eventos = porOperador[op].sort((a, b) => (a.ms || 0) - (b.ms || 0));
      let abertoPendente = null;
      eventos.forEach(ev => {
        if (ev.tipo === fam.inicio) {
          if (abertoPendente) semPar.push(abertoPendente); // 2 inícios seguidos sem término — anomalia
          abertoPendente = ev;
        } else {
          if (abertoPendente) {
            const id = gerarIdApontamento();
            atualizacoes.push({ sheetRow: abertoPendente.sheetRow, abertoId: id });
            atualizacoes.push({ sheetRow: ev.sheetRow, abertoId: id });
            abertoPendente = null;
          } else {
            semPar.push(ev); // término sem início correspondente
          }
        }
      });
      if (abertoPendente) semPar.push(abertoPendente); // sobrou início nunca fechado
    });
  });

  return { atualizacoes, semPar };
}

function previewBackfillIdsParadaRetrabalho() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  if (!abaRe) return { success: false, message: 'Aba Respostas não encontrada.' };
  const dadosRe = abaRe.getDataRange().getValues();
  const { atualizacoes, semPar } = _calcularBackfillIdsParadaRetrabalho(dadosRe);
  return {
    success: true,
    paresEncontrados: atualizacoes.length / 2,
    semParEncontrados: semPar.length,
    amostraPares: atualizacoes.slice(0, 20),
    amostraSemPar: semPar.slice(0, 20).map(e => ({ sheetRow: e.sheetRow, tipo: e.tipo })),
  };
}

function executarBackfillIdsParadaRetrabalho() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaRe = ss.getSheetByName(ABA_RESPOSTAS);
  if (!abaRe) return { success: false, message: 'Aba Respostas não encontrada.' };
  const dadosRe = abaRe.getDataRange().getValues();
  const { atualizacoes, semPar } = _calcularBackfillIdsParadaRetrabalho(dadosRe);
  if (atualizacoes.length === 0) {
    return { success: true, atualizados: 0, semParEncontrados: semPar.length, message: 'Nenhum par encontrado pra atualizar.' };
  }
  const resultado = migrarIdsHistoricos(atualizacoes);
  return Object.assign({}, resultado, { semParEncontrados: semPar.length });
}

// ================================================================
// Deletar linhas por número de linha da planilha (col A = Carimbo de data/hora).
// Verifica que cada linha é do tipo ABERTURA antes de remover.
// dryRun=true → apenas lista o que seria deletado, sem apagar.
// ================================================================
function deletarLinhasPorNumero(rows, dryRun, tiposPermitidos) {
  // tiposPermitidos: array de tipos aceitos para deleção (default: ['ABERTURA'])
  const tipos = Array.isArray(tiposPermitidos) && tiposPermitidos.length > 0
    ? tiposPermitidos
    : ['ABERTURA'];
  if (!rows || rows.length === 0) {
    return { success: false, message: 'Lista de linhas vazia.' };
  }
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  const lastRow = aba.getLastRow();

  // Ler todos os dados uma vez (bulk)
  const dados = aba.getRange(1, 1, lastRow, 20).getValues();

  const confirmadas = [];  // linhas válidas (ABERTURA confirmada)
  const rejeitadas  = [];  // linhas que não são ABERTURA ou fora do range

  for (const rowNum of rows) {
    const r = parseInt(rowNum);
    if (!r || r < 2 || r > lastRow) {
      rejeitadas.push({ row: r, motivo: 'fora do range' });
      continue;
    }
    const tipo = String(dados[r - 1][2] || '').trim(); // col C = tipo
    const func = String(dados[r - 1][1] || '').trim(); // col B = operador
    const ts   = dados[r - 1][0];                      // col A = timestamp
    if (!tipos.includes(tipo)) {
      rejeitadas.push({ row: r, tipo, func, motivo: 'tipo não permitido (permitidos: ' + tipos.join(',') + ')' });
      continue;
    }
    let tsStr;
    try { tsStr = ts instanceof Date ? Utilities.formatDate(ts, 'GMT-3', 'dd/MM/yyyy HH:mm:ss') : String(ts).trim(); }
    catch(e) { tsStr = String(ts); }
    confirmadas.push({ row: r, ts: tsStr, func });
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      totalSolicitado: rows.length,
      confirmadas: confirmadas.length,
      rejeitadas: rejeitadas.length,
      detalheRejeitadas: rejeitadas,
      amostraConfirmadas: confirmadas.slice(0, 10),
      message: 'DRY-RUN: ' + confirmadas.length + ' linha(s) seriam deletadas, ' + rejeitadas.length + ' rejeitadas.'
    };
  }

  // Deletar de baixo para cima para não deslocar índices
  const linhasOrdenadas = confirmadas.map(r => r.row).sort((a, b) => b - a);
  for (const linha of linhasOrdenadas) {
    aba.deleteRow(linha);
  }
  SpreadsheetApp.flush();

  // Reconstruir aba de abertos
  let recResult = null;
  try { recResult = reconstruirAbertos(); } catch(e) { recResult = { error: e.message }; }

  return {
    success: true,
    totalSolicitado: rows.length,
    deletados: linhasOrdenadas.length,
    rejeitadas: rejeitadas.length,
    detalheRejeitadas: rejeitadas.length > 0 ? rejeitadas : undefined,
    reconstruirAbertos: recResult,
    message: linhasOrdenadas.length + ' linha(s) deletada(s). ' + rejeitadas.length + ' rejeitada(s) (tipo != ABERTURA ou fora do range).'
  };
}

function localizarLinhasPorIdentificadores(identifiers, deletar) {
  if (!identifiers || identifiers.length === 0) {
    return { success: false, message: 'Lista de identificadores vazia.' };
  }

  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_RESPOSTAS);
  if (!aba) return { success: false, message: 'Aba Respostas não encontrada.' };

  // Constrói Set de chaves: "func|||ts"
  const keysAlvo = new Set(identifiers.map(id => id.func + '|||' + id.ts));

  const dados = aba.getDataRange().getValues();
  const linhasEncontradas = [];
  const naoEncontrados = [...keysAlvo]; // debug: quais não foram achados

  for (let i = 1; i < dados.length; i++) {
    const row    = dados[i];
    const tsRaw  = row[0];
    const func   = String(row[1] || '').trim();
    const tipo   = String(row[2] || '').trim();
    if (tipo !== 'ABERTURA') continue; // só ABERTURAs

    let tsStr;
    if (tsRaw instanceof Date) {
      try { tsStr = Utilities.formatDate(tsRaw, 'GMT-3', 'dd/MM/yyyy HH:mm:ss'); }
      catch(e) { continue; }
    } else if (tsRaw) {
      tsStr = String(tsRaw).trim();
    } else {
      continue;
    }

    const chave = func + '|||' + tsStr;
    if (keysAlvo.has(chave)) {
      const op    = String(row[3]  || '').trim() || String(row[11] || '').trim();
      const item  = String(row[4]  || '').trim();
      const serie = String(row[5]  || '').trim().split(' | ')[0].trim();
      linhasEncontradas.push({ sheetRow: i + 1, ts: tsStr, func, op, item, serie });
      // Remove do conjunto de não-encontrados
      const idx = naoEncontrados.indexOf(chave);
      if (idx >= 0) naoEncontrados.splice(idx, 1);
    }
  }

  if (!deletar) {
    return {
      success:        true,
      buscados:       keysAlvo.size,
      encontrados:    linhasEncontradas.length,
      naoEncontrados: naoEncontrados.length,
      items:          linhasEncontradas
    };
  }

  // ── DELETAR ─────────────────────────────────────────────────────
  if (linhasEncontradas.length === 0) {
    return { success: true, removidos: 0, message: 'Nenhuma linha localizada para deleção.' };
  }

  const linhas = linhasEncontradas.map(r => r.sheetRow).sort((a, b) => b - a); // desc
  for (const linha of linhas) {
    aba.deleteRow(linha);
  }
  SpreadsheetApp.flush();

  let recResult = null;
  try { recResult = reconstruirAbertos(); } catch(e) { recResult = { error: e.message }; }

  return {
    success:         true,
    buscados:        keysAlvo.size,
    removidos:       linhas.length,
    naoEncontrados:  naoEncontrados.length,
    linhasDeletadas: [...linhas].reverse(),
    reconstruirAbertos: recResult,
    message:         linhas.length + ' linha(s) deletada(s). ' + naoEncontrados.length + ' identificador(es) não localizado(s).'
  };
}


// ================================================================
// DIAGNÓSTICO PONTUAL (auditoria pós-deploy v4.4): lista todas as linhas cruas de
// Saldo_Parcial cujo NrSerie ou CodItem batem no filtro — usado para investigar
// duplicatas legadas encontradas no filtro dono-only. Somente leitura.
// ================================================================
function _diagSaldo(filtroSerie, filtroItem) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_SALDO);
  const dados = aba.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < dados.length; i++) {
    const r = dados[i];
    if ((filtroSerie && String(r[0]).includes(filtroSerie)) || (filtroItem && String(r[1]).includes(filtroItem))) {
      out.push({ linha: i+1, nrSerie: r[0], codItem: r[1], operacao: r[2], qtd: r[3], ultimaAtualizacao: r[4], abertoId: r[5], operadorCod: r[6], qtdPlTotal: r[7], isLote: r[8] });
    }
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
function _diag509126() { return _diagSaldo('22000086', '509126'); }

// Remove uma linha específica de Saldo_Parcial pelo abertoId — usado para limpar resíduos
// órfãos (abertoId fantasma, sem par em Abertos/Respostas) encontrados na auditoria pós-v4.4.
function _removerSaldoPorAbertoId(abertoId) {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName(ABA_SALDO);
  const dados = aba.getDataRange().getValues();
  let removidas = 0;
  for (let i = dados.length - 1; i >= 1; i--) {
    if (String(dados[i][5] || '').trim() === abertoId) {
      aba.deleteRow(i + 1);
      removidas++;
    }
  }
  Logger.log(removidas + ' linha(s) removida(s) de Saldo_Parcial para abertoId=' + abertoId);
  return removidas;
}
function _removerTesteBlindagem() { return _removerSaldoPorAbertoId('AP-B2B2E2D95F'); }

// ================================================================
// DIAGNÓSTICO: falhas do poka-yoke (dupla abertura sem fechamento) ================
// Percorre Respostas cronologicamente por operador, tratando qualquer tipo de
// ABERTURA/INÍCIO como "abre" e qualquer FECHAMENTO/TÉRMINO como "fecha". Reporta
// todo caso em que uma segunda abertura aconteceu antes de um fechamento da anterior
// para o MESMO operador — exatamente o cenário relatado (poka-yoke falhou).
// Somente leitura, não altera nada.
// ================================================================
function _diagPokaYokeFalhas() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  // Auditoria post-mortem de histórico completo — inclui Historico.
  const dados = _lerRespostasComHistorico(ss);

  const TIPOS_ABERTURA_SET   = new Set(['ABERTURA', 'INÍCIO DE RETRABALHO', 'INÍCIO DE PARADA']);
  const TIPOS_FECHAMENTO_SET = new Set(['FECHAMENTO', 'TÉRMINO DE RETRABALHO', 'TÉRMINO DE PARADA']);

  // Monta lista de eventos com operador normalizado + timestamp em ms, ordenada cronologicamente
  // (a ordem das linhas já deveria ser cronológica, mas edições/migrações podem ter bagunçado).
  const eventos = [];
  for (let i = 1; i < dados.length; i++) {
    const row = dados[i];
    const tipoRaw = String(row[COL_RE.TIPO] || '').trim().normalize('NFC');
    if (!TIPOS_ABERTURA_SET.has(tipoRaw) && !TIPOS_FECHAMENTO_SET.has(tipoRaw)) continue;
    const nomeOp = String(row[COL_RE.OPERADOR] || '');
    const mCod = nomeOp.match(/\d+/);
    if (!mCod) continue;
    const opCod = normalizarCodigoOp(mCod[0]);
    // parseCarimboGsMs espera a STRING já formatada (dd/MM/yyyy HH:mm:ss) por formatarCarimboGs —
    // passar o valor bruto da célula (Date, ISO string, etc.) direto quebra com
    // "s.match is not a function" quando o Sheets devolve um objeto Date.
    const carimboFormatado = formatarCarimboGs(row[COL_RE.CARIMBO]);
    const ms = parseCarimboGsMs(carimboFormatado);
    eventos.push({
      linha: i + 1,
      operador: opCod,
      operadorNome: nomeOp,
      tipo: tipoRaw,
      ehAbertura: TIPOS_ABERTURA_SET.has(tipoRaw),
      carimbo: carimboFormatado,
      carimboMs: ms,
      serie: String(row[COL_RE.SERIE] || ''),
      operacao: String(row[COL_RE.OPERACAO] || ''),
      codItem: String(row[COL_RE.COD_ITEM] || ''),
      abertoId: String(row[COL_RE.ABERTO_ID] || '').trim(),
    });
  }
  eventos.sort((a, b) => (a.carimboMs || 0) - (b.carimboMs || 0));

  // Agrupa por operador e percorre cronologicamente
  const porOperador = {};
  eventos.forEach(e => {
    if (!porOperador[e.operador]) porOperador[e.operador] = [];
    porOperador[e.operador].push(e);
  });

  const falhas = [];
  Object.keys(porOperador).forEach(op => {
    let aberto = null; // evento de abertura atualmente "em aberto" para este operador
    porOperador[op].forEach(e => {
      if (e.ehAbertura) {
        if (aberto) {
          // Segunda abertura sem fechamento da anterior — FALHA DO POKA-YOKE
          falhas.push({
            operador: op,
            operadorNome: e.operadorNome,
            aberturaAnterior: { linha: aberto.linha, tipo: aberto.tipo, carimbo: aberto.carimbo, serie: aberto.serie, operacao: aberto.operacao, codItem: aberto.codItem, abertoId: aberto.abertoId },
            aberturaNova:     { linha: e.linha,      tipo: e.tipo,      carimbo: e.carimbo,      serie: e.serie,      operacao: e.operacao,      codItem: e.codItem,      abertoId: e.abertoId },
            gapSegundos: aberto.carimboMs && e.carimboMs ? Math.round((e.carimboMs - aberto.carimboMs) / 1000) : null,
          });
        }
        aberto = e;
      } else {
        // Fechamento — fecha o que estava aberto, independente de bater o tipo exato
        // (para fins de diagnóstico; a validação de tipo exato é feita em outro lugar)
        aberto = null;
      }
    });
  });

  const resultado = {
    totalEventos: eventos.length,
    totalOperadoresComEventos: Object.keys(porOperador).length,
    totalFalhas: falhas.length,
  };

  // Grava em aba dedicada — o Logger.log trunca saídas grandes (88 falhas com todos os
  // detalhes excede o limite), e uma planilha é muito mais fácil de examinar por completo.
  const NOME_ABA_DIAG = 'Diag_PokaYoke';
  let abaDiag = ss.getSheetByName(NOME_ABA_DIAG);
  if (abaDiag) ss.deleteSheet(abaDiag); // recria do zero a cada execução
  abaDiag = ss.insertSheet(NOME_ABA_DIAG);
  abaDiag.appendRow([
    'Operador', 'OperadorNome',
    'Tipo Anterior (nunca fechado)', 'Carimbo Anterior', 'Série Anterior', 'Operação Anterior', 'CodItem Anterior', 'AbertoId Anterior', 'Linha Anterior',
    'Tipo Nova Abertura', 'Carimbo Nova', 'Série Nova', 'Operação Nova', 'CodItem Nova', 'AbertoId Nova', 'Linha Nova',
    'Gap (segundos)', 'Gap (horas)',
  ]);
  abaDiag.setFrozenRows(1);
  abaDiag.getRange(1, 1, 1, 18).setFontWeight('bold').setBackground('#4a2060').setFontColor('#fff');
  if (falhas.length > 0) {
    const linhas = falhas.map(f => [
      f.operador, f.operadorNome,
      f.aberturaAnterior.tipo, f.aberturaAnterior.carimbo, f.aberturaAnterior.serie, f.aberturaAnterior.operacao, f.aberturaAnterior.codItem, f.aberturaAnterior.abertoId, f.aberturaAnterior.linha,
      f.aberturaNova.tipo, f.aberturaNova.carimbo, f.aberturaNova.serie, f.aberturaNova.operacao, f.aberturaNova.codItem, f.aberturaNova.abertoId, f.aberturaNova.linha,
      f.gapSegundos, f.gapSegundos != null ? Math.round(f.gapSegundos / 3600 * 100) / 100 : '',
    ]);
    abaDiag.getRange(2, 1, linhas.length, 18).setValues(linhas);
  }

  Logger.log(JSON.stringify(resultado, null, 2));
  return resultado;
}

// Análise agregada dos 88 casos gravados por _diagPokaYokeFalhas na aba Diag_PokaYoke —
// classifica em buckets pra entender o PADRÃO comum sem precisar ler linha por linha.
function _diagPokaYokeResumo() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const aba = ss.getSheetByName('Diag_PokaYoke');
  if (!aba) return { erro: 'Rode _diagPokaYokeFalhas primeiro.' };
  const dados = aba.getDataRange().getValues();

  let comAbertoIdAnterior = 0, semAbertoIdAnterior = 0;
  const porTipoAnterior = {};
  const porTipoNova = {};
  const porOperador = {};
  let gapMenos1min = 0, gap1a10min = 0, gap10a60min = 0, gapMais1h = 0;
  const amostraSemAbertoId = [];
  const amostraComAbertoId = [];

  for (let i = 1; i < dados.length; i++) {
    const row = dados[i];
    const tipoAnterior = row[2];   // C: Tipo Anterior
    const abertoIdAnterior = String(row[7] || '').trim(); // H: AbertoId Anterior
    const tipoNova = row[9];       // J: Tipo Nova Abertura
    const operador = row[0];       // A: Operador
    const gapSeg = Number(row[16]) || 0; // Q: Gap (segundos)

    porTipoAnterior[tipoAnterior] = (porTipoAnterior[tipoAnterior] || 0) + 1;
    porTipoNova[tipoNova] = (porTipoNova[tipoNova] || 0) + 1;
    porOperador[operador] = (porOperador[operador] || 0) + 1;

    if (abertoIdAnterior) {
      comAbertoIdAnterior++;
      if (amostraComAbertoId.length < 3) amostraComAbertoId.push({ linha: i+1, operador, tipoAnterior, abertoIdAnterior, gapSeg });
    } else {
      semAbertoIdAnterior++;
      if (amostraSemAbertoId.length < 3) amostraSemAbertoId.push({ linha: i+1, operador, tipoAnterior, gapSeg });
    }

    if (gapSeg < 60) gapMenos1min++;
    else if (gapSeg < 600) gap1a10min++;
    else if (gapSeg < 3600) gap10a60min++;
    else gapMais1h++;
  }

  const resumo = {
    totalCasos: dados.length - 1,
    comAbertoIdAnterior, semAbertoIdAnterior,
    porTipoAnterior, porTipoNova, porOperador,
    distribuicaoGap: { gapMenos1min, gap1a10min, gap10a60min, gapMais1h },
    amostraSemAbertoId, amostraComAbertoId,
  };
  Logger.log(JSON.stringify(resumo, null, 2));
  return resumo;
}

// Cruza os 88 casos históricos (aba Diag_PokaYoke) com o estado ATUAL para determinar quais
// ainda representam algo genuinamente pendente hoje — vs. já resolvidos depois (o operador
// fechou normalmente numa sessão posterior, mesmo que o controle interno tenha "esquecido").
// Somente leitura.
function _diagPokaYokeStatusAtual() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const abaDiag = ss.getSheetByName('Diag_PokaYoke');
  if (!abaDiag) return { erro: 'Rode _diagPokaYokeFalhas primeiro.' };
  const dadosDiag = abaDiag.getDataRange().getValues();

  // Precisa do histórico completo (viva + Historico) — um abertoId antigo pode ter sido
  // fechado há muito tempo e já arquivado; sem isso, pareceria "ainda pendente" incorretamente.
  const dadosRe = _lerRespostasComHistorico(ss);
  // Conjunto de abertoIds que JÁ TÊM um fechamento correspondente (qualquer tipo de fechamento)
  // — se o abertoId anterior está aqui, já foi resolvido, mesmo que tardiamente.
  const TIPOS_FECHAMENTO_SET = new Set(['FECHAMENTO', 'TÉRMINO DE RETRABALHO', 'TÉRMINO DE PARADA'].map(s => s.normalize('NFC')));
  const abertoIdsFechados = new Set();
  for (let i = 1; i < dadosRe.length; i++) {
    const tipoRow = String(dadosRe[i][COL_RE.TIPO] || '').trim().normalize('NFC');
    if (!TIPOS_FECHAMENTO_SET.has(tipoRow)) continue;
    const idRow = String(dadosRe[i][COL_RE.ABERTO_ID] || '').trim();
    if (idRow) abertoIdsFechados.add(idRow);
  }

  // Conjunto de abertoIds ainda presentes na aba Abertos ATUAL (controle ativo)
  const abaAb = ss.getSheetByName(ABA_ABERTOS);
  const dadosAb = abaAb ? abaAb.getDataRange().getValues() : [];
  const abertoIdsNoControleAtual = new Set();
  for (let i = 1; i < dadosAb.length; i++) {
    const idRow = String(dadosAb[i][COL_AB.ABERTO_ID] || '').trim();
    if (idRow) abertoIdsNoControleAtual.add(idRow);
  }

  let jaResolvidos = 0, aindaPendentesNoControle = 0, semAbertoIdParaVerificar = 0, indeterminados = 0;
  const listaPendentes = [];
  for (let i = 1; i < dadosDiag.length; i++) {
    const row = dadosDiag[i];
    const abertoIdAnterior = String(row[7] || '').trim(); // H: AbertoId Anterior
    if (!abertoIdAnterior) { semAbertoIdParaVerificar++; continue; }
    if (abertoIdsFechados.has(abertoIdAnterior)) { jaResolvidos++; continue; }
    if (abertoIdsNoControleAtual.has(abertoIdAnterior)) {
      aindaPendentesNoControle++;
      listaPendentes.push({
        operador: row[0], operadorNome: row[1], tipoAnterior: row[2], carimboAnterior: row[3],
        serieAnterior: row[4], operacaoAnterior: row[5], codItemAnterior: row[6], abertoIdAnterior,
      });
    } else {
      // Não está fechado em Respostas E não está mais no controle Abertos — provavelmente foi
      // sobrescrito por uma abertura ainda mais nova (encadeamento de 3+ aberturas) antes desta
      // correção existir. Precisa de investigação manual.
      indeterminados++;
    }
  }

  const resultado = {
    totalCasos: dadosDiag.length - 1,
    jaResolvidos, aindaPendentesNoControle, semAbertoIdParaVerificar, indeterminados,
    listaPendentes,
  };
  Logger.log(JSON.stringify(resultado, null, 2));
  return resultado;
}
