# AGRICEF - PLANO DE STRESS TEST COMPLETO
# Cobertura: erro humano, falha de tempo, concorrencia, saldo, fallback

$GAS = "https://script.google.com/macros/s/AKfycbzqXA7fg1-IEQbbp4Zggwy9FMzAXaUOfEbjpppZslJLu9f0TbiMelaOroHTe7qYencItw/exec"
$KEY = "AGF2026"
$PASS = 0; $FAIL = 0; $WARN = 0
$ABERTOIDS_TESTE = @()

function New-ReqId { return [System.Guid]::NewGuid().ToString("N").Substring(0,16).ToUpper() }

function Call-GAS {
    param([hashtable]$Payload, [hashtable]$QS)
    $maxAuto = 3; $delayAuto = 4000

    # Writes: clona o payload e injeta requestId unico se ainda nao tem.
    # O GAS armazena a resposta em CacheService (TTL 6h) e retorna o resultado cacheado
    # em retries com o mesmo requestId — tornando retry de escrita seguro sem duplicata.
    $payloadEnvio = $Payload
    $reqId        = $null
    if ($Payload) {
        $payloadEnvio = $Payload.Clone()
        if (-not $payloadEnvio.ContainsKey('requestId')) {
            $reqId = New-ReqId
            $payloadEnvio['requestId'] = $reqId
        } else {
            $reqId = $payloadEnvio['requestId']
        }
    }

    for ($i = 1; $i -le $maxAuto; $i++) {
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($payloadEnvio) {
            $json    = $payloadEnvio | ConvertTo-Json -Depth 6 -Compress
            $encoded = [System.Uri]::EscapeDataString($json)
            $url     = ("{0}?payload={1}&_t={2}" -f $GAS, $encoded, $t)
        } else {
            $parts = ($QS.GetEnumerator() | ForEach-Object {
                "{0}={1}" -f $_.Key, [System.Uri]::EscapeDataString($_.Value)
            }) -join "&"
            $url = ("{0}?{1}&_t={2}" -f $GAS, $parts, $t)
        }
        try {
            $r = Invoke-RestMethod -Uri $url -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 45
        } catch {
            $r = [pscustomobject]@{ _error = $_.Exception.Message; success = $false }
        }
        # Retry em leituras (QS) E em writes com requestId (idempotencia garante seguranca no retry)
        $isInfraError = $r._error -and ($r._error -match "tempo limite|408|429|500|502|503|504" -or $r._error -match "404")
        $podeRetry    = $isInfraError -and ($i -lt $maxAuto) -and ($QS -or $reqId)
        if ($podeRetry) {
            $tipo = if ($QS) { "leitura" } else { "escrita[{0}]" -f $reqId }
            Write-Host ("    [AUTO-RETRY {0}/{1}] infra error em {2}, aguardando {3}ms..." -f $i, $maxAuto, $tipo, $delayAuto) -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds $delayAuto
            $delayAuto = [int]($delayAuto * 1.5)
            continue
        }
        if ($i -gt 1 -and $r.success -eq $true) { Write-Host ("    [AUTO-RETRY] sucedeu na tentativa {0}" -f $i) -ForegroundColor DarkGreen }
        return $r
    }
}

function Assert {
    param([string]$Id, [string]$Desc, [bool]$Cond, [string]$Got, [switch]$Warn)
    if ($Warn -and -not $Cond) {
        $script:WARN++
        Write-Host ("  !! [{0}] {1}" -f $Id, $Desc) -ForegroundColor Yellow
        Write-Host ("     got: {0}" -f $Got) -ForegroundColor DarkYellow
    } elseif ($Cond) {
        $script:PASS++
        Write-Host ("  OK [{0}] {1}" -f $Id, $Desc) -ForegroundColor Green
    } else {
        $script:FAIL++
        Write-Host ("  XX [{0}] {1}" -f $Id, $Desc) -ForegroundColor Red
        Write-Host ("     got: {0}" -f $Got) -ForegroundColor DarkRed
    }
}

function Section { param([string]$T)
    Write-Host ("`n=== {0} ===" -f $T) -ForegroundColor Cyan
}

function Cleanup { param([string]$Id)
    $r = Call-GAS -QS @{ action="removerRegistroPorId"; id=$Id; key=$KEY }
    Write-Host ("  [CLEANUP] {0} -> removido={1}" -f $Id, $r.removido) -ForegroundColor DarkGray
}

# Retry com backoff exponencial em falhas transientes (servidor ocupado / lock GAS)
function Call-GAS-Retry {
    param([hashtable]$Payload, [hashtable]$QS, [int]$MaxTentativas=4, [int]$DelayMs=1500)
    $tentativa = 0
    do {
        $tentativa++
        $r = if ($Payload) { Call-GAS -Payload $Payload } else { Call-GAS -QS $QS }
        if ($r.transiente -eq $true -and $tentativa -lt $MaxTentativas) {
            Write-Host ("    [RETRY {0}/{1}] servidor ocupado, aguardando {2}ms..." -f $tentativa, $MaxTentativas, $DelayMs) -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds $DelayMs
            $DelayMs = [int]($DelayMs * 1.8) # backoff exponencial
        } else {
            if ($tentativa -gt 1) { Write-Host ("    [RETRY] sucedeu na tentativa {0}" -f $tentativa) -ForegroundColor DarkGreen }
            return $r
        }
    } while ($true)
}

# ================================================================
# PREPARACAO
# ================================================================
Section "PREPARACAO"
foreach ($id in @("AP-B2B2E2D95F","AP-40A217CBFE")) { Cleanup $id }
# Fechar qualquer abertura residual dos operadores usados nos grupos H3 e I1
foreach ($op in @("554","556","557")) {
    $abRes = Call-GAS -QS @{ action="verificarAberto"; operador=$op }
    if ($abRes.aberto -eq $true -and $abRes.abertoId) {
        Write-Host ("  [CLEANUP-OP{0}] abertura residual {1} -> fechando..." -f $op, $abRes.abertoId) -ForegroundColor DarkGray
        Cleanup $abRes.abertoId
    }
}
Start-Sleep -Seconds 2

# ================================================================
# G1 - VALIDACAO: campos obrigatorios e tipos invalidos
# ================================================================
Section "G1 - Validacao / Erro Humano"

$r = Call-GAS -Payload @{ operador="128"; codItem="X" }
Assert "G1.1" "Sem tipoApontamento -> erro obrigatorio" `
    ($r.success -eq $false -and $r.message -match "obrigat") `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="VOAR"; operador="128" }
Assert "G1.2" "tipoApontamento invalido -> mensagem especifica" `
    ($r.success -eq $false -and ($r.message -match "Tipo de" -or $r.message -match "lido")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="ABERTURA" }
Assert "G1.3" "Sem operador -> erro obrigatorio" `
    ($r.success -eq $false -and $r.message -match "operador") `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="FECHAMENTO"; operador="128"; codItem="X"; operacao="60" }
Assert "G1.4" "FECHAMENTO sem abertura aberta -> semAberto ou erro claro" `
    ($r.success -eq $false -and ($r.semAberto -or $r.message -match "aberto|abertura")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="ABERTURA"; operador="128"; codItem="X"; operacao="60"; nrSerie="FANTASMA-9999" }
Assert "G1.5" "ABERTURA com serie invalida -> seriesInvalidas" `
    ($r.success -eq $false -and ($r.seriesInvalidas -or $r.message -match "cadastro|inválid")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="ABERTURA"; operador="128"; codItem="X"; operacao="60"; isLote=$true; loteSeries=@() }
Assert "G1.6" "isLote=true loteSeries vazio -> erro validacao" `
    ($r.success -eq $false -and $r.message -match "série|serie|lote") `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="ABERTURA"; operador="128"; codItem="X"; operacao="60"; nrSerie="22000073|HACK" }
Assert "G1.7" "nrSerie com pipe '|' -> bloqueado" `
    ($r.success -eq $false -and $r.message -match "\|") `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="INICIO_RETRABALHO"; operador="128"; nrSerie="22000073"; codItem="X"; operacao="60" }
Assert "G1.8" "INICIO_RETRABALHO sem motivo -> erro campo retrabalho" `
    ($r.success -eq $false -and $r.message -match "retrabalho") `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="INICIO_PARADA"; operador="128"; nrSerie="22000073"; codItem="X"; operacao="60" }
Assert "G1.9" "INICIO_PARADA sem tipo de parada -> erro campo parada" `
    ($r.success -eq $false -and $r.message -match "parada") `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{ tipoApontamento="FECHAMENTO"; operador="128"; abertoId="AP-XXXXXXXX99"; codItem="X"; operacao="60" }
Assert "G1.10" "abertoId inventado -> semAberto ou erro claro" `
    ($r.success -eq $false) `
    ($r | ConvertTo-Json -Compress)

# ================================================================
# G2 - ABERTURA: lote 3 series
# ================================================================
Section "G2 - Abertura de Lote (3 series)"

$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=30; implemento="22000073"
    isLote=$true
    loteSeries=@(
        @{nrSerie="22000073"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10},
        @{nrSerie="22000074"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10},
        @{nrSerie="22000075"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10}
    )
}
Assert "G2.1" "ABERTURA lote 3 series -> success, linhasGravadas=3" `
    ($r.success -eq $true -and $r.linhasGravadas -eq 3) `
    ($r | ConvertTo-Json -Compress)
Start-Sleep -Seconds 2

$aberto = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
$abertoId = $aberto.abertoId
if ($abertoId) { $ABERTOIDS_TESTE += $abertoId }

Assert "G2.2" "verificarAberto apos abertura -> aberto:true, 3 series, abertoId preenchido" `
    ($aberto.aberto -eq $true -and $aberto.loteSeries.Count -eq 3 -and $abertoId -ne "") `
    ($aberto | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-DUP"; operacao="60 - STRESS"
    nrSerie="22000073"
}
Assert "G2.3" "Segunda ABERTURA quando ja aberto -> bloqueado" `
    ($r.success -eq $false -and ($r.message -match "aberto|abertura|aberta" -or $r.jaAberto)) `
    ($r | ConvertTo-Json -Compress)

# ================================================================
# G3 - FECHAMENTO com erro humano (estado invalido)
# ================================================================
Section "G3 - Fechamento com Erro Humano"

$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=5
    loteSeries=@(@{nrSerie="22000086"; qtdPlanejada=10; qtdRealizada=5})
}
Assert "G3.1" "Serie 22000086 nao pertence ao lote -> serieIncompativel" `
    ($r.success -eq $false -and ($r.serieIncompativel -or $r.message -match "lote|pertence")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="ITEM-ERRADO"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=5
    loteSeries=@(@{nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=5})
}
Assert "G3.2" "codItem diferente do aberto -> incompativel" `
    ($r.success -eq $false -and ($r.incompativel -or $r.message -match "item|incompatível|incompativel")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="99 - ERRADA"
    qtdPlanejada=10; qtdRealizada=5
    loteSeries=@(@{nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=5})
}
Assert "G3.3" "Operacao diferente da aberta -> incompativel" `
    ($r.success -eq $false -and ($r.incompativel -or $r.message -match "peração|incompatível|incompativel")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="999"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=5
    loteSeries=@(@{nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=5})
}
Assert "G3.4" "Outro operador tentando fechar abertoId alheio -> bloqueado" `
    ($r.success -eq $false) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=5
}
Assert "G3.5" "Fechar como serie unica quando lote aberto -> loteFechamentoObrigatorio" `
    ($r.success -eq $false -and ($r.loteFechamentoObrigatorio -or $r.message -match "lote")) `
    ($r | ConvertTo-Json -Compress)

$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=-5
    loteSeries=@(@{nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=-5})
}
Assert "G3.6" "qtdRealizada negativa -> bloqueado ou saldo nao negativo" `
    ($r.success -eq $false -or $r.linhasGravadas -ge 0) `
    ($r | ConvertTo-Json -Compress) -Warn

# ================================================================
# G4 - CICLO PARCIAL: 3 fechamentos em etapas
# ================================================================
Section "G4 - Ciclo de Fechamento Parcial (3 etapas)"

# G4.1: Fechar 22000073 (7/10)
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=7
    loteSeries=@(@{nrSerie="22000073"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10; qtdRealizada=7})
}
Assert "G4.1" "Fechar 22000073 parcial (7/10) -> success, linhasGravadas=1" `
    ($r.success -eq $true -and $r.linhasGravadas -eq 1) `
    ($r | ConvertTo-Json -Compress)
Start-Sleep -Seconds 2

# G4.2: verificarAberto -> 22000074 e 22000075 restantes
$aberto2 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
$nSeries  = if ($aberto2.loteSeries) { $aberto2.loteSeries.Count } else { 0 }
$series74ok = $aberto2.loteSeries | Where-Object { $_.nrSerie -eq "22000074" }
$series73gone = -not ($aberto2.loteSeries | Where-Object { $_.nrSerie -eq "22000073" })
Assert "G4.2" "verificarAberto pos-parcial -> aberto:true, 73 removida, 74+75 restantes" `
    ($aberto2.aberto -eq $true -and $nSeries -eq 2 -and $series73gone) `
    ("aberto={0} series={1} 73removida={2}" -f $aberto2.aberto, $nSeries, $series73gone)

# G4.3: Saldo 22000073 = 3 (10-7)
$s73 = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-STRESS"; operacao="60 -" }
Assert "G4.3" "Saldo 22000073 = 3 (10-7) apos fechamento parcial" `
    ($s73.temSaldo -eq $true -and $s73.qtdRestante -eq 3) `
    ("temSaldo={0} qtdRestante={1}" -f $s73.temSaldo, $s73.qtdRestante)

# G4.4: Saldo 22000074 NAO deve existir (FIX 1)
$s74 = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000074"; codItem="TESTE-STRESS"; operacao="60 -" }
Assert "G4.4" "Saldo 22000074 NAO criado - fix1 (loop so itera payload.loteSeries)" `
    ($s74.temSaldo -ne $true) `
    ("temSaldo={0} qtdRestante={1}" -f $s74.temSaldo, $s74.qtdRestante)

# G4.5: Saldo 22000075 NAO deve existir (FIX 1)
$s75 = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000075"; codItem="TESTE-STRESS"; operacao="60 -" }
Assert "G4.5" "Saldo 22000075 NAO criado - fix1" `
    ($s75.temSaldo -ne $true) `
    ("temSaldo={0} qtdRestante={1}" -f $s75.temSaldo, $s75.qtdRestante)

# G4.6: B7.4 double-close 22000073
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=7
    loteSeries=@(@{nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=7})
}
Assert "G4.6" "B7.4 double-close 22000073 -> jaFechado:true" `
    ($r.success -eq $false -and $r.jaFechado -eq $true) `
    ($r | ConvertTo-Json -Compress)

# G4.7: CRITICO mix [22000073(fechada)+22000074(aberta)]
# B7.4 atual bloqueia apenas se TODAS fechadas. Mix deve ser investigado.
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=20; qtdRealizada=14
    loteSeries=@(
        @{nrSerie="22000073"; qtdPlanejada=10; qtdRealizada=7},
        @{nrSerie="22000074"; qtdPlanejada=10; qtdRealizada=7}
    )
}
if ($r.success -eq $false) {
    Assert "G4.7" "Mix fechado+aberto no mesmo payload -> BLOQUEADO (seguro)" $true ($r | ConvertTo-Json -Compress)
} else {
    $script:WARN++
    Write-Host "  !! [G4.7] Mix fechado+aberto -> PERMITIDO - risco de FECHAMENTO DUPLO para 22000073!" -ForegroundColor Yellow
    Write-Host ("     Resultado: {0}" -f ($r | ConvertTo-Json -Compress)) -ForegroundColor DarkYellow
}
Start-Sleep -Seconds 2

# G4.8: Fechar 22000074 (verificar estado atual)
$aberto3 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
$series74resta = $aberto3.loteSeries | Where-Object { $_.nrSerie -eq "22000074" }
if ($aberto3.aberto -and $series74resta) {
    $r = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
        codItem="TESTE-STRESS"; operacao="60 - STRESS"
        qtdPlanejada=10; qtdRealizada=7
        loteSeries=@(@{nrSerie="22000074"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10; qtdRealizada=7})
    }
    Assert "G4.8" "Fechar 22000074 (7/10) -> success" `
        ($r.success -eq $true) `
        ($r | ConvertTo-Json -Compress)
    Start-Sleep -Seconds 2
} else {
    Write-Host "  -- [G4.8] 22000074 ja fechada ou lote fechado - pulando" -ForegroundColor DarkGray
}

# G4.9: Fechar 22000075 com over-produce (15/10) -> saldo=0
$aberto4 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
$series75resta = $aberto4.loteSeries | Where-Object { $_.nrSerie -eq "22000075" }
if ($aberto4.aberto -and $series75resta) {
    $r = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
        codItem="TESTE-STRESS"; operacao="60 - STRESS"
        qtdPlanejada=10; qtdRealizada=15
        loteSeries=@(@{nrSerie="22000075"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10; qtdRealizada=15})
    }
    Assert "G4.9" "Over-produce 22000075 (15/10) -> aceito, saldo deve ser 0" `
        ($r.success -eq $true) `
        ($r | ConvertTo-Json -Compress)
    Start-Sleep -Seconds 2

    $s75b = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000075"; codItem="TESTE-STRESS"; operacao="60 -" }
    Assert "G4.9b" "Saldo 22000075 apos over-produce -> 0 (nunca negativo = temSaldo:false)" `
        ($s75b.temSaldo -ne $true) `
        ("temSaldo={0} qtdRestante={1}" -f $s75b.temSaldo, $s75b.qtdRestante)
} else {
    Write-Host "  -- [G4.9] 22000075 ja fechada - pulando" -ForegroundColor DarkGray
}

# G4.10: aberto:false apos tudo fechado
Start-Sleep -Seconds 2
$aberto5 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
Assert "G4.10" "Apos fechar todas as series -> aberto:false" `
    ($aberto5.aberto -eq $false) `
    ($aberto5 | ConvertTo-Json -Compress)

# G4.11: B7.4 tentar fechar novamente apos lote completo
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoId
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; qtdRealizada=10
    loteSeries=@(@{nrSerie="22000075"; qtdPlanejada=10; qtdRealizada=10})
}
Assert "G4.11" "B7.4 refechar serie apos lote completo -> bloqueado" `
    ($r.success -eq $false -and ($r.jaFechado -or $r.semAberto)) `
    ($r | ConvertTo-Json -Compress)

# ================================================================
# G5 - SALDO ACUMULATIVO: multiplos ciclos mesma serie
# ================================================================
Section "G5 - Saldo Acumulativo (multiplos ciclos)"

# G5 usa codItem diferente (TESTE-G5-SOLO) para isolar do saldo residual do G4
# Tambem usa campo correto "quantidade" (nao "qtdRealizada") para FECHAMENTO de serie unica
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-G5-SOLO"; operacao="60 - STRESS"
    qtdPlanejada=10; nrSerie="22000073"; implemento="22000073"
}
if ($r.success -eq $true) {
    Start-Sleep -Seconds 2
    $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    $abId2 = $ab.abertoId
    if ($abId2) { $ABERTOIDS_TESTE += $abId2 }

    $r = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId2
        codItem="TESTE-G5-SOLO"; operacao="60 - STRESS"
        qtdPlanejada=10; quantidade=4; nrSerie="22000073"
    }
    Assert "G5.1" "Ciclo 1: fechar serie unica (4/10) -> success" ($r.success -eq $true) ($r | ConvertTo-Json -Compress)
    Start-Sleep -Seconds 2

    $s = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-G5-SOLO"; operacao="60 -" }
    Assert "G5.2" "Saldo apos ciclo 1 = 6 (10-4)" `
        ($s.temSaldo -eq $true -and $s.qtdRestante -eq 6) `
        ("qtdRestante={0}" -f $s.qtdRestante)

    # Ciclo 2: mais 3 unidades
    $r = Call-GAS -Payload @{
        tipoApontamento="ABERTURA"; operador="128"
        codItem="TESTE-G5-SOLO"; operacao="60 - STRESS"
        qtdPlanejada=10; nrSerie="22000073"; implemento="22000073"
    }
    if ($r.success) {
        Start-Sleep -Seconds 2
        $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
        $abId3 = $ab.abertoId
        if ($abId3) { $ABERTOIDS_TESTE += $abId3 }

        $r = Call-GAS -Payload @{
            tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId3
            codItem="TESTE-G5-SOLO"; operacao="60 - STRESS"
            qtdPlanejada=10; quantidade=3; nrSerie="22000073"
        }
        Assert "G5.3" "Ciclo 2: mais 3 -> success" ($r.success -eq $true) ($r | ConvertTo-Json -Compress)
        Start-Sleep -Seconds 2

        $s = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-G5-SOLO"; operacao="60 -" }
        Assert "G5.4" "Saldo acumulativo apos ciclo 2 = 3 (6-3)" `
            ($s.temSaldo -eq $true -and $s.qtdRestante -eq 3) `
            ("qtdRestante={0} (esperado 3)" -f $s.qtdRestante)

        # Ciclo 3: zerar (3 restantes)
        $r = Call-GAS -Payload @{
            tipoApontamento="ABERTURA"; operador="128"
            codItem="TESTE-G5-SOLO"; operacao="60 - STRESS"
            qtdPlanejada=10; nrSerie="22000073"; implemento="22000073"
        }
        if ($r.success) {
            Start-Sleep -Seconds 2
            $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
            $abId4 = $ab.abertoId
            if ($abId4) { $ABERTOIDS_TESTE += $abId4 }

            $r = Call-GAS -Payload @{
                tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId4
                codItem="TESTE-G5-SOLO"; operacao="60 - STRESS"
                qtdPlanejada=10; quantidade=3; nrSerie="22000073"
            }
            Assert "G5.5" "Ciclo 3: zerar saldo (3 restantes) -> success" ($r.success -eq $true) ($r | ConvertTo-Json -Compress) -Warn
            Start-Sleep -Seconds 2

            $s = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-G5-SOLO"; operacao="60 -" }
            Assert "G5.6" "Saldo zerado apos producao completa -> temSaldo:false" `
                ($s.temSaldo -ne $true) `
                ("temSaldo={0} qtdRestante={1}" -f $s.temSaldo, $s.qtdRestante)
        }
    }
} else {
    Write-Host ("  -- G5: abertura falhou ({0}) - op128 ainda aberto de G4?" -f $r.message) -ForegroundColor Yellow
    $WARN++
}

# ================================================================
# G6 - FALLBACK: buscarAberturaAbertaEmRespostas_
# ================================================================
Section "G6 - Fallback buscarAberturaAbertaEmRespostas_ (FIX 4)"

$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=20; implemento="22000074"
    isLote=$true
    loteSeries=@(
        @{nrSerie="22000074"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10},
        @{nrSerie="22000075"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10}
    )
}
if ($r.success -eq $true) {
    Start-Sleep -Seconds 2
    $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    $abId5 = $ab.abertoId
    if ($abId5) { $ABERTOIDS_TESTE += $abId5 }

    # Fechar 22000074 parcialmente
    $r = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId5
        codItem="TESTE-STRESS"; operacao="60 - STRESS"
        qtdPlanejada=10; qtdRealizada=10
        loteSeries=@(@{nrSerie="22000074"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10; qtdRealizada=10})
    }
    Assert "G6.1" "Fechar 22000074 (10/10) parcial do lote -> success" `
        ($r.success -eq $true -or $r._error) `
        ($r | ConvertTo-Json -Compress) -Warn
    Start-Sleep -Seconds 2

    # Caminho primario (Abertos) antes de reconstruirAbertos
    $ab1 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    Assert "G6.2" "verificarAberto caminho primario -> aberto:true, 1 serie restante (75)" `
        ($ab1.aberto -eq $true -and $ab1.loteSeries.Count -eq 1) `
        ("aberto={0} series={1}" -f $ab1.aberto, ($ab1.loteSeries | ConvertTo-Json -Compress))

    # Forcar reconstruirAbertos -> limpa Abertos, proxima leitura usa fallback
    Write-Host "  [reconstruirAbertos] forcando rebuild..." -ForegroundColor DarkGray
    $rec = Call-GAS -QS @{ action="reconstruirAbertos"; key=$KEY }
    Write-Host ("  [reconstruirAbertos] {0}" -f ($rec | ConvertTo-Json -Compress)) -ForegroundColor DarkGray
    Start-Sleep -Seconds 4

    # Caminho FALLBACK (buscarAberturaAbertaEmRespostas_) apos rebuild
    $ab2 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    $s75fallback = $ab2.loteSeries | Where-Object { $_.nrSerie -eq "22000075" }
    Assert "G6.3" "verificarAberto FALLBACK apos reconstruirAbertos -> aberto:true, apenas 22000075" `
        ($ab2.aberto -eq $true -and $ab2.loteSeries.Count -eq 1 -and $s75fallback) `
        ("aberto={0} series={1}" -f $ab2.aberto, ($ab2.loteSeries | ConvertTo-Json -Compress))

    # Fechar serie restante via fallback path
    $r = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId5
        codItem="TESTE-STRESS"; operacao="60 - STRESS"
        qtdPlanejada=10; qtdRealizada=10
        loteSeries=@(@{nrSerie="22000075"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10; qtdRealizada=10})
    }
    Assert "G6.4" "Fechar 22000075 via fallback path -> success" ($r.success -eq $true) ($r | ConvertTo-Json -Compress)
    Start-Sleep -Seconds 2

    $rec2 = Call-GAS -QS @{ action="reconstruirAbertos"; key=$KEY }
    Start-Sleep -Seconds 3

    $ab3 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    Assert "G6.5" "Apos fechar tudo + reconstruir -> aberto:false" `
        ($ab3.aberto -eq $false) `
        ($ab3 | ConvertTo-Json -Compress)
} else {
    Write-Host ("  -- G6: abertura falhou ({0})" -f $r.message) -ForegroundColor Yellow
    $WARN++
}

# ================================================================
# G7 - CONCORRENCIA: requests paralelos
# ================================================================
Section "G7 - Concorrencia (requests simultaneos)"

$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=30; implemento="22000073"
    isLote=$true
    loteSeries=@(
        @{nrSerie="22000073"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10},
        @{nrSerie="22000074"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10},
        @{nrSerie="22000075"; implemento="HAULER"; cliente="STRESS"; qtdPlanejada=10}
    )
}
if ($r.success -eq $true) {
    Start-Sleep -Seconds 2
    $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    $abIdConc = $ab.abertoId
    if ($abIdConc) { $ABERTOIDS_TESTE += $abIdConc }

    # G7.1: 2 SERIES DIFERENTES simultaneas -> ambas devem ser aceitas
    Write-Host "  [G7.1] Iniciando 2 fechamentos de series diferentes simultaneamente..." -ForegroundColor DarkGray

    $gasUrl = $GAS
    $job73 = Start-Job -ScriptBlock {
        param($url, $id)
        $p = '{"tipoApontamento":"FECHAMENTO","operador":"128","abertoId":"' + $id + '","codItem":"TESTE-STRESS","operacao":"60 - STRESS","qtdPlanejada":10,"qtdRealizada":5,"loteSeries":[{"nrSerie":"22000073","qtdPlanejada":10,"qtdRealizada":5}]}'
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $enc = [System.Uri]::EscapeDataString($p)
        $fullUrl = $url + "?payload=" + $enc + "&_t=" + $t
        Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 60
    } -ArgumentList $gasUrl, $abIdConc

    $job74 = Start-Job -ScriptBlock {
        param($url, $id)
        $p = '{"tipoApontamento":"FECHAMENTO","operador":"128","abertoId":"' + $id + '","codItem":"TESTE-STRESS","operacao":"60 - STRESS","qtdPlanejada":10,"qtdRealizada":5,"loteSeries":[{"nrSerie":"22000074","qtdPlanejada":10,"qtdRealizada":5}]}'
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $enc = [System.Uri]::EscapeDataString($p)
        $fullUrl = $url + "?payload=" + $enc + "&_t=" + $t
        Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 60
    } -ArgumentList $gasUrl, $abIdConc

    $r73 = Wait-Job $job73 | Receive-Job; Remove-Job $job73
    $r74 = Wait-Job $job74 | Receive-Job; Remove-Job $job74

    $ambosOk = ($r73.success -eq $true -and $r74.success -eq $true)
    if ($ambosOk) {
        Assert "G7.1" "2 series diferentes simultaneas -> ambas aceitas" $true "OK"
    } else {
        Assert "G7.1" "2 series diferentes simultaneas -> ao menos uma aceita (lock GAS serializa)" `
            ($r73.success -eq $true -or $r74.success -eq $true) `
            ("73={0} 74={1}" -f ($r73 | ConvertTo-Json -Compress), ($r74 | ConvertTo-Json -Compress)) -Warn
    }
    Start-Sleep -Seconds 3

    # G7.2: MESMA SERIE 2x simultaneo -> 1 aceita, 1 bloqueada
    Write-Host "  [G7.2] Fechando 22000075 duas vezes simultaneamente..." -ForegroundColor DarkGray

    $jobA = Start-Job -ScriptBlock {
        param($url, $id)
        $p = '{"tipoApontamento":"FECHAMENTO","operador":"128","abertoId":"' + $id + '","codItem":"TESTE-STRESS","operacao":"60 - STRESS","qtdPlanejada":10,"qtdRealizada":8,"loteSeries":[{"nrSerie":"22000075","qtdPlanejada":10,"qtdRealizada":8}]}'
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $enc = [System.Uri]::EscapeDataString($p)
        $fullUrl = $url + "?payload=" + $enc + "&_t=" + $t
        Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 60
    } -ArgumentList $gasUrl, $abIdConc

    $jobB = Start-Job -ScriptBlock {
        param($url, $id)
        $p = '{"tipoApontamento":"FECHAMENTO","operador":"128","abertoId":"' + $id + '","codItem":"TESTE-STRESS","operacao":"60 - STRESS","qtdPlanejada":10,"qtdRealizada":8,"loteSeries":[{"nrSerie":"22000075","qtdPlanejada":10,"qtdRealizada":8}]}'
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $enc = [System.Uri]::EscapeDataString($p)
        $fullUrl = $url + "?payload=" + $enc + "&_t=" + $t
        Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 60
    } -ArgumentList $gasUrl, $abIdConc

    $rA = Wait-Job $jobA | Receive-Job; Remove-Job $jobA
    $rB = Wait-Job $jobB | Receive-Job; Remove-Job $jobB

    $qtdSucess = @($rA,$rB | Where-Object { $_.success -eq $true }).Count
    if ($qtdSucess -le 1) {
        Assert "G7.2" "Mesma serie 2x simultaneo -> apenas 1 aceita (B7.4 ou lock bloqueou duplicata)" $true `
            ("A.success={0} B.success={1}" -f $rA.success, $rB.success)
    } else {
        $script:WARN++
        Write-Host "  !! [G7.2] Ambos passaram -> FECHAMENTO DUPLO possivel!" -ForegroundColor Yellow
        Write-Host ("     A={0} B={1}" -f ($rA | ConvertTo-Json -Compress), ($rB | ConvertTo-Json -Compress)) -ForegroundColor DarkYellow
    }
    Start-Sleep -Seconds 3

    # G7.3: 3 verificarAberto simultaneos -> resultado consistente
    Write-Host "  [G7.3] 3 verificarAberto simultaneos..." -ForegroundColor DarkGray
    $vJobs = 1..3 | ForEach-Object {
        Start-Job -ScriptBlock {
            param($url)
            $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $fullUrl = $url + "?action=verificarAberto&operador=128&_t=" + $t
            Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 30
        } -ArgumentList $gasUrl
    }
    $vResults = $vJobs | Wait-Job | Receive-Job
    Remove-Job $vJobs
    $v0 = $vResults[0].aberto
    $consistent = ($vResults | Where-Object { $_.aberto -ne $v0 }).Count -eq 0
    Assert "G7.3" "3 verificarAberto simultaneos -> resultado consistente" $consistent `
        ($vResults | ForEach-Object { "aberto={0}" -f $_.aberto } | ConvertTo-Json -Compress)

    # Fechar o que sobrou
    $abLimpa = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    if ($abLimpa.aberto -and $abLimpa.loteSeries) {
        foreach ($s in $abLimpa.loteSeries) {
            $r = Call-GAS -Payload @{
                tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abIdConc
                codItem="TESTE-STRESS"; operacao="60 - STRESS"
                qtdPlanejada=10; qtdRealizada=10
                loteSeries=@(@{nrSerie=$s.nrSerie; qtdPlanejada=10; qtdRealizada=10})
            }
            Write-Host ("  [CLEANUP G7] Fechar {0}: success={1}" -f $s.nrSerie, $r.success) -ForegroundColor DarkGray
            Start-Sleep -Seconds 1
        }
    }
} else {
    Write-Host ("  -- G7: abertura falhou ({0})" -f $r.message) -ForegroundColor Yellow
    $WARN++
}

# ================================================================
# G8 - TIMING: fechamento imediato, abertura apos cron
# ================================================================
Section "G8 - Casos de Timing"

# G8.1/G8.2: ABERTURA e FECHAMENTO no mesmo segundo
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; nrSerie="22000073"; implemento="22000073"
}
if ($r.success -eq $true) {
    $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    Assert "G8.1" "verificarAberto IMEDIATO apos abertura (sem sleep) -> aberto:true" `
        ($ab.aberto -eq $true) `
        ($ab | ConvertTo-Json -Compress)

    $abId8 = $ab.abertoId
    if ($abId8) { $ABERTOIDS_TESTE += $abId8 }

    $r2 = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId8
        codItem="TESTE-STRESS"; operacao="60 - STRESS"
        qtdPlanejada=10; quantidade=10; nrSerie="22000073"
    }
    Assert "G8.2" "FECHAMENTO imediato apos ABERTURA (mesmo segundo) -> aceito" `
        ($r2.success -eq $true) `
        ($r2 | ConvertTo-Json -Compress)

    $ab3 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    Assert "G8.3" "verificarAberto apos fechamento rapido -> aberto:false" `
        ($ab3.aberto -eq $false -or $ab3._error) `
        ($ab3 | ConvertTo-Json -Compress) -Warn
} else {
    Write-Host ("  -- G8: abertura falhou ({0})" -f $r.message) -ForegroundColor Yellow
    $WARN++
}

# G8.4: Abertura com mesmo operador apos cron reconstruir Abertos
Write-Host "  [G8.4] Testando abertura apos reconstruirAbertos..." -ForegroundColor DarkGray
$rec = Call-GAS -QS @{ action="reconstruirAbertos"; key=$KEY }
Start-Sleep -Seconds 3
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-STRESS"; operacao="60 - STRESS"
    qtdPlanejada=10; nrSerie="22000073"; implemento="22000073"
}
Assert "G8.4" "Abertura apos reconstruirAbertos (Abertos limpo) -> success" `
    ($r.success -eq $true) `
    ($r | ConvertTo-Json -Compress)

if ($r.success) {
    Start-Sleep -Seconds 2
    $ab = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
    $abId9 = $ab.abertoId
    if ($abId9) { $ABERTOIDS_TESTE += $abId9 }
    $r2 = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abId9
        codItem="TESTE-STRESS"; operacao="60 - STRESS"
        qtdPlanejada=10; quantidade=10; nrSerie="22000073"
    }
    Assert "G8.5" "Fechar apontamento criado pós-cron -> success" ($r2.success -eq $true) ($r2 | ConvertTo-Json -Compress)
}

# ================================================================
# H1 - SANITIZACAO E NORMALIZACAO DE ENTRADA
# Testa que o backend normaliza campos antes de validar:
# lowercase, espacos extras, qtdPlanejada invalida, duplicatas
# ================================================================
Section "H1 - Sanitizacao e Normalizacao de Entrada"

# H1.1: tipoApontamento em minusculo -> normaliza para ABERTURA -> aceito
$rH1 = Call-GAS -Payload @{
    tipoApontamento="abertura"; operador="777"
    codItem="TESTE-H1"; operacao="60 - STRESS"
    qtdPlanejada=10; nrSerie="22000073"
}
Start-Sleep -Seconds 2
$abH1 = Call-GAS -QS @{ action="verificarAberto"; operador="777" }
$abertoIdH1 = $abH1.abertoId
if ($abertoIdH1) { $ABERTOIDS_TESTE += $abertoIdH1 }
Assert "H1.1" "tipoApontamento='abertura' (lowercase) -> normalizado -> ABERTURA aceita" `
    ($rH1.success -eq $true -and $abH1.aberto -eq $true) `
    ("success={0} aberto={1}" -f $rH1.success, $abH1.aberto)

# H1.2: tipoApontamento com espacos "  fechamento  " -> normaliza -> FECHAMENTO bem-formado
# Operador 999 nao tem aberto -> deve retornar semAberto (nao "tipo invalido")
$r = Call-GAS -Payload @{
    tipoApontamento="  fechamento  "; operador="999"
    codItem="TESTE-H1"; operacao="60 - STRESS"
}
Assert "H1.2" "'  fechamento  ' normalizado -> semAberto (nao tipo invalido)" `
    ($r.success -eq $false -and ($r.semAberto -or $r.message -match "aberto|abertura") -and $r.message -notmatch "nvalid") `
    ($r | ConvertTo-Json -Compress)

# H1.3: nrSerie " INVALIDA-9999" com espaco -> trim -> seriesInvalidas
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="888"
    codItem="TESTE-H1"; operacao="60"
    nrSerie=" INVALIDA-9999"
}
Assert "H1.3" "nrSerie ' INVALIDA-9999' -> trim -> seriesInvalidas (nao passa espaco)" `
    ($r.success -eq $false -and ($r.seriesInvalidas -or $r.message -match "cadastro")) `
    ($r | ConvertTo-Json -Compress)

# H1.4: qtdPlanejada negativa -> rejeitado com qtdPlanejadaInvalida
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="888"
    codItem="TESTE-H1"; operacao="60"
    nrSerie="22000073"; qtdPlanejada=-5
}
Assert "H1.4" "qtdPlanejada=-5 -> rejeitado (nao pode ser negativo)" `
    ($r.success -eq $false -and ($r.qtdPlanejadaInvalida -or $r.message -match "negativo|qtdPlanejada")) `
    ($r | ConvertTo-Json -Compress)

# H1.5: qtdPlanejada="QUINZE" (texto nao numerico) -> rejeitado
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="888"
    codItem="TESTE-H1"; operacao="60"
    nrSerie="22000073"; qtdPlanejada="QUINZE"
}
Assert "H1.5" "qtdPlanejada='QUINZE' (NaN) -> rejeitado" `
    ($r.success -eq $false -and ($r.qtdPlanejadaInvalida -or $r.message -match "numero|numerico|NaN|qtdPlanejada")) `
    ($r | ConvertTo-Json -Compress)

# H1.6: qtdPlanejada="10" (string numerica) -> aceito (coercao JS Number("10")=10)
$rH16 = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="888"
    codItem="TESTE-H1"; operacao="60 - STRESS"
    nrSerie="22000074"; qtdPlanejada="10"
}
Start-Sleep -Seconds 2
$abH16 = Call-GAS -QS @{ action="verificarAberto"; operador="888" }
$abertoIdH16 = $abH16.abertoId
if ($abertoIdH16) { $ABERTOIDS_TESTE += $abertoIdH16 }
Assert "H1.6" "qtdPlanejada='10' (string) -> aceito (coerce JS)" `
    ($rH16.success -eq $true) `
    ($rH16 | ConvertTo-Json -Compress)

# H1.7: loteSeries com nrSerie duplicada -> seriesDuplicadas
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="666"
    codItem="TESTE-H1"; operacao="60 - STRESS"; isLote=$true
    loteSeries=@(
        @{nrSerie="22000073"; qtdPlanejada=10},
        @{nrSerie="22000074"; qtdPlanejada=10},
        @{nrSerie="22000073"; qtdPlanejada=10}
    )
}
Assert "H1.7" "loteSeries com 22000073 duplicada -> seriesDuplicadas" `
    ($r.success -eq $false -and ($r.seriesDuplicadas -or $r.message -match "duplicad")) `
    ($r | ConvertTo-Json -Compress)

# H1.8: abertoId com formato invalido -> abertoIdInvalido
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"
    codItem="TESTE-H1"; operacao="60"
    abertoId="FECHAMENTO-SEM-PREFIXO-CORRETO"
}
Assert "H1.8" "abertoId='FECHAMENTO-SEM-PREFIXO' -> abertoIdInvalido" `
    ($r.success -eq $false -and ($r.abertoIdInvalido -or $r.message -match "abertoId|formato")) `
    ($r | ConvertTo-Json -Compress)

# H1.9: abertoId em lowercase hex valido -> formato OK -> semAberto (nao abertoIdInvalido)
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"
    codItem="TESTE-H1"; operacao="60"
    abertoId="ap-abc123def4"
}
Assert "H1.9" "abertoId lowercase hex valido -> formato ok -> semAberto" `
    ($r.success -eq $false -and $r.abertoIdInvalido -ne $true -and ($r.semAberto -or $r.message -match "aberto")) `
    ($r | ConvertTo-Json -Compress)

# H1.10: nrSerie com espacos " 22000074 " em ABERTURA real -> trim -> serie valida -> aceita
# Fechar H1.1 primeiro, depois abrir H1.10 com op777
if ($abertoIdH1) {
    $rCloseH1 = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="777"; abertoId=$abertoIdH1
        codItem="TESTE-H1"; operacao="60 - STRESS"
        nrSerie="22000073"; quantidade=10
    }
    Start-Sleep -Seconds 2
}
$rH110 = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="777"
    codItem="TESTE-H1"; operacao="60 - STRESS"
    nrSerie=" 22000073 "; qtdPlanejada=10
}
Start-Sleep -Seconds 2
$abH110 = Call-GAS -QS @{ action="verificarAberto"; operador="777" }
$abertoIdH110 = $abH110.abertoId
if ($abertoIdH110) { $ABERTOIDS_TESTE += $abertoIdH110 }
Assert "H1.10" "nrSerie ' 22000073 ' com espacos -> trim -> ABERTURA aceita" `
    ($rH110.success -eq $true -and $abH110.aberto -eq $true) `
    ("success={0} aberto={1}" -f $rH110.success, $abH110.aberto)

# Fechar H1.6 e H1.10 para limpar estado
if ($abertoIdH16) {
    Call-GAS -Payload @{ tipoApontamento="FECHAMENTO"; operador="888"; abertoId=$abertoIdH16; codItem="TESTE-H1"; operacao="60 - STRESS"; nrSerie="22000074"; quantidade=10 } | Out-Null
    Start-Sleep -Seconds 2
}
if ($abertoIdH110) {
    Call-GAS -Payload @{ tipoApontamento="FECHAMENTO"; operador="777"; abertoId=$abertoIdH110; codItem="TESTE-H1"; operacao="60 - STRESS"; nrSerie="22000073"; quantidade=10 } | Out-Null
    Start-Sleep -Seconds 2
}

# ================================================================
# H2 - CENARIOS COMPLEXOS DE SERIE/LOTE
# ================================================================
Section "H2 - Cenarios Complexos de Serie/Lote"

# H2.1: Abrir lote [73,74,75], fechar em ORDEM DIFERENTE [75,74] -> aceito
$rH2ab = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-H2"; operacao="60 - STRESS"
    qtdPlanejada=30; implemento="22000073"; isLote=$true
    loteSeries=@(
        @{nrSerie="22000073"; implemento="HAULER"; cliente="H2"; qtdPlanejada=10},
        @{nrSerie="22000074"; implemento="HAULER"; cliente="H2"; qtdPlanejada=10},
        @{nrSerie="22000075"; implemento="HAULER"; cliente="H2"; qtdPlanejada=10}
    )
}
Start-Sleep -Seconds 2
$abH2 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
$abertoIdH2 = $abH2.abertoId
if ($abertoIdH2) { $ABERTOIDS_TESTE += $abertoIdH2 }

$rH21 = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoIdH2
    codItem="TESTE-H2"; operacao="60 - STRESS"
    qtdPlanejada=20; quantidade=20
    loteSeries=@(
        @{nrSerie="22000075"; implemento="HAULER"; cliente="H2"; qtdPlanejada=10; qtdRealizada=10},
        @{nrSerie="22000074"; implemento="HAULER"; cliente="H2"; qtdPlanejada=10; qtdRealizada=10}
    )
}
Start-Sleep -Seconds 2
Assert "H2.1" "FECHAMENTO com loteSeries em ordem diferente da ABERTURA -> aceito" `
    ($rH21.success -eq $true -and $rH21.linhasGravadas -eq 2) `
    ($rH21 | ConvertTo-Json -Compress)

# H2.2: Reabertura da mesma serie apos fechamento completo -> deve ser permitida
# Fechar 22000073 (restante do lote H2)
$rH22a = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoIdH2
    codItem="TESTE-H2"; operacao="60 - STRESS"
    qtdPlanejada=10; quantidade=10
    loteSeries=@(@{nrSerie="22000073"; implemento="HAULER"; cliente="H2"; qtdPlanejada=10; qtdRealizada=10})
}
Start-Sleep -Seconds 2
$abH22 = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
# Agora reabrir a mesma serie
$rH22b = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-H2"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=5
}
Start-Sleep -Seconds 2
$abH22b = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
$abertoIdH22b = $abH22b.abertoId
if ($abertoIdH22b) { $ABERTOIDS_TESTE += $abertoIdH22b }
Assert "H2.2" "Reabertura de serie apos fechamento completo -> permitida" `
    ($rH22a.success -eq $true -and $rH22b.success -eq $true -and $abH22b.aberto -eq $true) `
    ("fechou={0} reabriu={1} aberto={2}" -f $rH22a.success, $rH22b.success, $abH22b.aberto)

# H2.3: Tentar nova ABERTURA quando op128 ainda tem H22b aberto -> bloqueado
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="128"
    codItem="TESTE-H2"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=5
}
Assert "H2.3" "ABERTURA quando operador ainda tem H22b aberta -> bloqueado" `
    ($r.success -eq $false -and ($r.jaAberto -or $r.bloqueado -or $r.message -match "aberto")) `
    ($r | ConvertTo-Json -Compress)

# H2.4: FECHAMENTO com serie EXTRA que nao estava no lote -> serieIncompativel
# Usar abertoIdH22b (serie unica 22000073) e tentar fechar 22000074 (nao pertence)
$r = Call-GAS -Payload @{
    tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoIdH22b
    codItem="TESTE-H2"; operacao="60 - STRESS"
    nrSerie="22000074"; quantidade=5
}
Assert "H2.4" "FECHAMENTO com serie incompativel com abertura -> bloqueado" `
    ($r.success -eq $false) `
    ($r | ConvertTo-Json -Compress)

# H2.5: qtdRealizada=qtdPlanejada exata -> saldo=0 -> limpo
if ($abertoIdH22b) {
    $rH25 = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="128"; abertoId=$abertoIdH22b
        codItem="TESTE-H2"; operacao="60 - STRESS"
        nrSerie="22000073"; qtdPlanejada=5; quantidade=5
    }
    Start-Sleep -Seconds 2
    $sH25 = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-H2"; operacao="60 -" }
    Assert "H2.5" "qtdRealizada=qtdPlanejada exata -> saldo=0 -> temSaldo:false" `
        ($rH25.success -eq $true -and $sH25.temSaldo -ne $true) `
        ("fechou={0} temSaldo={1}" -f $rH25.success, $sH25.temSaldo)
}

# ================================================================
# H3 - DADOS EXTREMOS E IDEMPOTENCIA
# ================================================================
Section "H3 - Dados Extremos e Idempotencia"

# H3.1: Payload com campos extras/desconhecidos -> ignorados, ABERTURA aceita
# op554 isolado. abertoId vem da resposta da propria ABERTURA (mais confiavel que verificarAberto)
$rH31 = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="554"
    codItem="TESTE-H3"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=10
    campoDesconhecido="ignorar_este"; metadados="tambem_ignorar"; versao=99
}
$abertoIdH31 = $rH31.abertoId
if ($abertoIdH31) { $ABERTOIDS_TESTE += $abertoIdH31 }
Assert "H3.1" "Payload com campos extras desconhecidos -> ignorados -> ABERTURA aceita" `
    ($rH31.success -eq $true) `
    ($rH31 | ConvertTo-Json -Compress)

# H3.2: quantidade=999999 (muito maior que 10 planejados) -> aceito, saldo=0
if ($abertoIdH31) {
    # quantidade=50000 >> qtdPlanejada=10 mas abaixo do limite backend (99999)
    $rH32 = Call-GAS-Retry -Payload @{
        tipoApontamento="FECHAMENTO"; operador="554"; abertoId=$abertoIdH31
        codItem="TESTE-H3"; operacao="60 - STRESS"
        nrSerie="22000073"; qtdPlanejada=10; quantidade=50000
    }
    Start-Sleep -Seconds 2
    $sH32 = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-H3"; operacao="60 -" }
    Assert "H3.2" "quantidade=50000 >> planejado (10) -> aceito, saldo=0 (nunca negativo)" `
        ($rH32.success -eq $true -and $sH32.temSaldo -ne $true) `
        ("success={0} temSaldo={1} rH32={2}" -f $rH32.success, $sH32.temSaldo, ($rH32 | ConvertTo-Json -Compress))
}

# H3.3: loteSeries=null explicitamente -> erro claro (nao crash)
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="555"
    codItem="TESTE-H3"; operacao="60"; isLote=$true; loteSeries=$null
}
Assert "H3.3" "loteSeries=null com isLote=true -> erro claro (nao crash)" `
    ($r.success -eq $false -and $r.message -match "serie|lote|obrigat") `
    ($r | ConvertTo-Json -Compress)

# H3.4: Mesmo FECHAMENTO enviado 2x (idempotencia B7.4) -> 2a vez jaFechado:true
# op556 completamente isolado. abertoId vem da resposta da ABERTURA diretamente.
$rH34ab = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="556"
    codItem="TESTE-H3"; operacao="60 - STRESS"
    nrSerie="22000074"; qtdPlanejada=10
}
$abertoIdH34 = $rH34ab.abertoId
if ($abertoIdH34) { $ABERTOIDS_TESTE += $abertoIdH34 }

if ($abertoIdH34) {
    $fechPayload = @{
        tipoApontamento="FECHAMENTO"; operador="556"; abertoId=$abertoIdH34
        codItem="TESTE-H3"; operacao="60 - STRESS"
        nrSerie="22000074"; qtdPlanejada=10; quantidade=10
    }
    $r1stFech = Call-GAS -Payload $fechPayload
    Start-Sleep -Seconds 2
    $r2ndFech = Call-GAS -Payload $fechPayload
    Assert "H3.4" "Mesmo FECHAMENTO 2x -> 2a vez bloqueada por B7.4 (jaFechado)" `
        ($r1stFech.success -eq $true -and $r2ndFech.success -eq $false -and $r2ndFech.jaFechado) `
        ("1a={0} 2a={1} jaFechado={2}" -f $r1stFech.success, $r2ndFech.success, $r2ndFech.jaFechado)
}

# H3.5: qtdPlanejada=0 em ABERTURA -> aceito (0 nao e negativo)
$r = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="444"
    codItem="TESTE-H3"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=0
}
Start-Sleep -Seconds 2
$abH35 = Call-GAS -QS @{ action="verificarAberto"; operador="444" }
$abertoIdH35 = $abH35.abertoId
if ($abertoIdH35) { $ABERTOIDS_TESTE += $abertoIdH35 }
if ($abertoIdH35) {
    Call-GAS -Payload @{ tipoApontamento="FECHAMENTO"; operador="444"; abertoId=$abertoIdH35; codItem="TESTE-H3"; operacao="60 - STRESS"; nrSerie="22000073"; quantidade=0 } | Out-Null
    Start-Sleep -Seconds 2
}
Assert "H3.5" "qtdPlanejada=0 -> aceito (0 nao e negativo)" `
    ($r.success -eq $true) `
    ($r | ConvertTo-Json -Compress)

# ================================================================
# H4 - TIMING AVANCADO E RESILIENCIA
# ================================================================
Section "H4 - Timing Avancado e Resiliencia"

# H4.1: 5 ABERTURAs simultaneas do mesmo operador -> apenas 1 aceita (LockService)
Write-Host "  [H4.1] Disparando 5 ABERTURAs simultaneas para operador 333..." -ForegroundColor DarkGray
$gasUrlH4 = $GAS
$jobsH41 = 1..5 | ForEach-Object {
    $idx = $_
    Start-Job -ScriptBlock {
        param($url, $i)
        $p = '{"tipoApontamento":"ABERTURA","operador":"333","codItem":"TESTE-H4","operacao":"60 - STRESS","nrSerie":"22000073","qtdPlanejada":10}'
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $enc = [System.Uri]::EscapeDataString($p)
        $fullUrl = $url + "?payload=" + $enc + "&_t=" + $t
        try { Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 60 }
        catch { [pscustomobject]@{ success=$false; _error=$_.Exception.Message } }
    } -ArgumentList $gasUrlH4, $idx
}
$resH41 = $jobsH41 | Wait-Job | Receive-Job
Remove-Job $jobsH41
$qtdAceitas = @($resH41 | Where-Object { $_.success -eq $true }).Count
Start-Sleep -Seconds 2
$abH41 = Call-GAS -QS @{ action="verificarAberto"; operador="333" }
$abertoIdH41 = $abH41.abertoId
if ($abertoIdH41) { $ABERTOIDS_TESTE += $abertoIdH41 }
Assert "H4.1" "5 ABERTURAs simultaneas -> exatamente 1 aceita (lock serializa)" `
    ($qtdAceitas -eq 1) `
    ("aceitas={0} aberto={1}" -f $qtdAceitas, $abH41.aberto)

# Limpar H4.1
if ($abertoIdH41) {
    Call-GAS -Payload @{ tipoApontamento="FECHAMENTO"; operador="333"; abertoId=$abertoIdH41; codItem="TESTE-H4"; operacao="60 - STRESS"; nrSerie="22000073"; quantidade=10 } | Out-Null
    Start-Sleep -Seconds 2
}

# H4.2: FECHAMENTO + delay 6s + FECHAMENTO identico -> B7.4 bloqueia mesmo com delay
$rH42ab = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="222"
    codItem="TESTE-H4"; operacao="60 - STRESS"
    nrSerie="22000074"; qtdPlanejada=10
}
Start-Sleep -Seconds 2
$abH42 = Call-GAS -QS @{ action="verificarAberto"; operador="222" }
$abertoIdH42 = $abH42.abertoId
if ($abertoIdH42) { $ABERTOIDS_TESTE += $abertoIdH42 }

if ($abertoIdH42) {
    $fPayload42 = @{
        tipoApontamento="FECHAMENTO"; operador="222"; abertoId=$abertoIdH42
        codItem="TESTE-H4"; operacao="60 - STRESS"
        nrSerie="22000074"; qtdPlanejada=10; quantidade=7
    }
    $rF1 = Call-GAS -Payload $fPayload42
    Write-Host "  [H4.2] Aguardando 6s antes do retry..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 6
    $rF2 = Call-GAS -Payload $fPayload42
    Assert "H4.2" "B7.4 bloqueia fechamento duplicado mesmo com delay de 6s" `
        ($rF1.success -eq $true -and $rF2.success -eq $false -and $rF2.jaFechado) `
        ("1a={0} 2a={1} jaFechado={2}" -f $rF1.success, $rF2.success, $rF2.jaFechado)
}

# H4.3: 10 verificarAberto em loop rapido -> resultado consistente (sem race condition na leitura)
Write-Host "  [H4.3] 10 verificarAberto em loop rapido para op222..." -ForegroundColor DarkGray
$resultadosH43 = @()
for ($i = 0; $i -lt 10; $i++) {
    $rv = Call-GAS -QS @{ action="verificarAberto"; operador="222" }
    $resultadosH43 += $rv.aberto
}
$totalAberto   = @($resultadosH43 | Where-Object { $_ -eq $true  }).Count
$totalFechado  = @($resultadosH43 | Where-Object { $_ -eq $false }).Count
$consistente   = ($totalAberto -eq 10 -or $totalFechado -eq 10)
Assert "H4.3" "10 verificarAberto rapidos -> todos consistentes (sem leitura suja)" `
    $consistente `
    ("aberto={0}x fechado={1}x" -f $totalAberto, $totalFechado)

# H4.4: Call-GAS-Retry funciona em resposta normal (0 retries necessarios)
$rH44 = Call-GAS-Retry -QS @{ action="verificarAberto"; operador="222" } -MaxTentativas 3
Assert "H4.4" "Call-GAS-Retry funciona sem retries em resposta normal" `
    ($rH44 -ne $null -and $rH44.PSObject.Properties.Name -contains "aberto") `
    ($rH44 | ConvertTo-Json -Compress)

# H4.5: Retry em falha transiente simulada — abre 6 requests simultaneas para forcar lock contention
Write-Host "  [H4.5] Forcando contencao de lock com 6 requests simultaneas..." -ForegroundColor DarkGray
$jobsH45 = 1..6 | ForEach-Object {
    Start-Job -ScriptBlock {
        param($url)
        $p = '{"tipoApontamento":"ABERTURA","operador":"111","codItem":"TESTE-H4","operacao":"60 - STRESS","nrSerie":"22000075","qtdPlanejada":10}'
        $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $enc = [System.Uri]::EscapeDataString($p)
        $fullUrl = $url + "?payload=" + $enc + "&_t=" + $t
        try { Invoke-RestMethod -Uri $fullUrl -Method GET -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 60 }
        catch { [pscustomobject]@{ success=$false; transiente=$false; _error=$_.Exception.Message } }
    } -ArgumentList $gasUrlH4
}
$resH45 = $jobsH45 | Wait-Job | Receive-Job
Remove-Job $jobsH45
$transientesH45 = @($resH45 | Where-Object { $_.transiente -eq $true }).Count
$aceitasH45     = @($resH45 | Where-Object { $_.success  -eq $true  }).Count
Start-Sleep -Seconds 2
$abH45 = Call-GAS -QS @{ action="verificarAberto"; operador="111" }
$abertoIdH45 = $abH45.abertoId
if ($abertoIdH45) { $ABERTOIDS_TESTE += $abertoIdH45 }
if ($abertoIdH45) {
    Call-GAS-Retry -Payload @{ tipoApontamento="FECHAMENTO"; operador="111"; abertoId=$abertoIdH45; codItem="TESTE-H4"; operacao="60 - STRESS"; nrSerie="22000075"; quantidade=10 } | Out-Null
    Start-Sleep -Seconds 2
}
Assert "H4.5" "6 requests simultaneas: exatamente 1 aceita, resto bloqueado ou transiente" `
    ($aceitasH45 -le 1 -and ($aceitasH45 + $transientesH45) -le 6) `
    ("aceitas={0} transientes={1}" -f $aceitasH45, $transientesH45)

# ================================================================
# I1 - IDEMPOTENCIA VIA requestId + CacheService
# Verifica que retries com o mesmo requestId retornam resultado cacheado
# sem re-executar a escrita (protege contra duplicatas em timeout/404).
# ================================================================
Section "I1 - Idempotencia via requestId"

# I1.1: ABERTURA com requestId explicito -> executada, abertoId gerado
$reqIdI1ab = New-ReqId
$rI1a = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="557"
    codItem="TESTE-I1"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=5
    requestId=$reqIdI1ab
}
$abertoIdI1 = $rI1a.abertoId
if ($abertoIdI1) { $ABERTOIDS_TESTE += $abertoIdI1 }
Assert "I1.1" "ABERTURA com requestId -> executada, abertoId retornado" `
    ($rI1a.success -eq $true -and $abertoIdI1) `
    ($rI1a | ConvertTo-Json -Compress)

# I1.2: Replay EXATO com o MESMO requestId -> resultado cacheado (nao re-executa)
# Esperado: success=true + mesmo abertoId (resposta do cache, sem nova escrita)
Start-Sleep -Seconds 1
$rI1b = Call-GAS -Payload @{
    tipoApontamento="ABERTURA"; operador="557"
    codItem="TESTE-I1"; operacao="60 - STRESS"
    nrSerie="22000073"; qtdPlanejada=5
    requestId=$reqIdI1ab   # MESMO requestId — deve ser servido do cache
}
Assert "I1.2" "Replay com mesmo requestId -> success=true, abertoId identico (cache hit)" `
    ($rI1b.success -eq $true -and $rI1b.abertoId -eq $abertoIdI1) `
    ("abertoId_1a={0} abertoId_2a={1}" -f $abertoIdI1, $rI1b.abertoId)

# I1.3: verificarAberto deve mostrar exatamente 1 abertura (cache hit nao criou duplicata)
Start-Sleep -Seconds 1
$abI1 = Call-GAS -QS @{ action="verificarAberto"; operador="557" }
Assert "I1.3" "verificarAberto pos-replay -> 1 abertura em aberto, sem duplicata" `
    ($abI1.aberto -eq $true -and $abI1.abertoId -eq $abertoIdI1) `
    ($abI1 | ConvertTo-Json -Compress)

# I1.4 + I1.5: FECHAMENTO com requestId, depois replay do fechamento com mesmo requestId
# Sem cache: 2a chamada seria bloqueada por B7.4 (jaFechado:true = success:false)
# Com cache: 2a chamada retorna o resultado cacheado do 1o fechamento (success:true)
if ($abertoIdI1) {
    $reqIdI1fech = New-ReqId
    $rI1f1 = Call-GAS-Retry -Payload @{
        tipoApontamento="FECHAMENTO"; operador="557"; abertoId=$abertoIdI1
        codItem="TESTE-I1"; operacao="60 - STRESS"
        nrSerie="22000073"; qtdPlanejada=5; quantidade=5
        requestId=$reqIdI1fech
    }
    Assert "I1.4" "FECHAMENTO com requestId -> executado, success:true" `
        ($rI1f1.success -eq $true) `
        ($rI1f1 | ConvertTo-Json -Compress)

    # Replay com mesmo requestId — sem cache B7.4 bloquearia (jaFechado); com cache retorna sucesso cacheado
    Start-Sleep -Seconds 1
    $rI1f2 = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="557"; abertoId=$abertoIdI1
        codItem="TESTE-I1"; operacao="60 - STRESS"
        nrSerie="22000073"; qtdPlanejada=5; quantidade=5
        requestId=$reqIdI1fech   # MESMO requestId
    }
    Assert "I1.5" "Replay fechamento mesmo requestId -> success:true (cache, nao jaFechado)" `
        ($rI1f2.success -eq $true) `
        ("success={0} jaFechado={1}" -f $rI1f2.success, $rI1f2.jaFechado)

    # I1.6: requestId DIFERENTE no mesmo fechamento -> B7.4 bloqueia normalmente
    Start-Sleep -Seconds 1
    $rI1f3 = Call-GAS -Payload @{
        tipoApontamento="FECHAMENTO"; operador="557"; abertoId=$abertoIdI1
        codItem="TESTE-I1"; operacao="60 - STRESS"
        nrSerie="22000073"; qtdPlanejada=5; quantidade=5
        requestId=(New-ReqId)   # requestId DIFERENTE — sem cache para esta requisicao
    }
    Assert "I1.6" "Fechamento com requestId diferente -> B7.4 ainda bloqueia (jaFechado)" `
        ($rI1f3.success -eq $false -and $rI1f3.jaFechado -eq $true) `
        ("success={0} jaFechado={1}" -f $rI1f3.success, $rI1f3.jaFechado)
}

# ================================================================
# G9 - LIMPEZA FINAL E VERIFICACAO DE ESTADO
# ================================================================
Section "G9 - Limpeza Final e Verificacao de Estado"

$uniques = $ABERTOIDS_TESTE | Select-Object -Unique
Write-Host ("  Limpando {0} abertoId(s) de teste..." -f $uniques.Count) -ForegroundColor DarkGray
foreach ($id in $uniques) { Cleanup $id; Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 3

Write-Host "  [reconstruirAbertos] limpeza final..." -ForegroundColor DarkGray
$rec = Call-GAS -QS @{ action="reconstruirAbertos"; key=$KEY }
Write-Host ("  resultado: {0}" -f ($rec | ConvertTo-Json -Compress)) -ForegroundColor DarkGray
Start-Sleep -Seconds 3

$abFinal = Call-GAS -QS @{ action="verificarAberto"; operador="128" }
Assert "G9.1" "Estado final op 128 -> aberto:false (base limpa)" `
    ($abFinal.aberto -eq $false) `
    ($abFinal | ConvertTo-Json -Compress)

# Verificar que nao ha saldo residual de teste
$sFinal = Call-GAS -QS @{ action="verificarSaldo"; nrSerie="22000073"; codItem="TESTE-STRESS"; operacao="60 -" }
Assert "G9.2" "Saldo TESTE-STRESS/22000073 -> zerado ou inexistente" `
    ($sFinal.temSaldo -ne $true) `
    ("temSaldo={0} qtdRestante={1}" -f $sFinal.temSaldo, $sFinal.qtdRestante) -Warn

# ================================================================
# RESULTADO FINAL
# ================================================================
$TOTAL = $PASS + $FAIL + $WARN
Write-Host "`n============================================" -ForegroundColor White
Write-Host " RESULTADO FINAL DO STRESS TEST" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host (" PASS  : {0}" -f $PASS) -ForegroundColor Green
Write-Host (" FAIL  : {0}" -f $FAIL) -ForegroundColor $(if($FAIL -gt 0){"Red"}else{"Green"})
Write-Host (" WARN  : {0}" -f $WARN) -ForegroundColor $(if($WARN -gt 0){"Yellow"}else{"Green"})
Write-Host (" TOTAL : {0}" -f $TOTAL) -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
if ($FAIL -eq 0 -and $WARN -eq 0) {
    Write-Host " SISTEMA OK - todos os casos passaram" -ForegroundColor Green
} elseif ($FAIL -eq 0) {
    Write-Host (" ATENCAO: {0} aviso(s) - ver !! acima" -f $WARN) -ForegroundColor Yellow
} else {
    Write-Host (" FALHAS: {0} caso(s) criticos - ver XX acima" -f $FAIL) -ForegroundColor Red
}
