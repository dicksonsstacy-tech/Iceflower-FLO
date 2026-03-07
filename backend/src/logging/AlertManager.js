// Simplified AlertManager for retirement mode
class AlertManager {
  constructor(options = {}) {
    this.config = {
      // Alert thresholds
      dailyLossWarningThreshold: options.dailyLossWarningThreshold || 0.5, // 50% of daily limit
      dailyLossCriticalThreshold: options.dailyLossCriticalThreshold || 0.8, // 80% of daily limit
      consecutiveLossesThreshold: options.consecutiveLossesThreshold || 2,
      emergencyStopAlert: options.emergencyStopAlert !== false, // Always alert on emergency stop
      
      // Alert channels
      enableConsoleAlerts: options.enableConsoleAlerts !== false,
      enableFileAlerts: options.enableFileAlerts !== false,
      enableSocketAlerts: options.enableSocketAlerts !== false,
      
      // Rate limiting
      alertCooldown: options.alertCooldown || 30000, // 30 seconds between same alert types
      maxAlertsPerHour: options.maxAlertsPerHour || 20,
      
      ...options
    }
    
    // Alert state
    this.alertHistory = []
    this.lastAlertTimes = new Map() // alertType -> timestamp
    this.alertCounts = new Map() // hourString -> count
    this.socketIO = null
    
    // Alert severity levels
    this.severityLevels = {
      INFO: 'info',
      WARNING: 'warning', 
      CRITICAL: 'critical',
      EMERGENCY: 'emergency'
    }
  }

  // Set socket.io instance for real-time alerts
  setSocketIO(socketIO) {
    this.socketIO = socketIO
  }

  // Main alert method
  alert(type, message, severity = 'info', data = {}) {
    try {
      // Check rate limiting
      if (!this.shouldSendAlert(type, severity)) {
        return false
      }
      
      const alert = {
        id: this.generateAlertId(),
        type,
        message,
        severity,
        data,
        timestamp: Date.now(),
        formattedTime: new Date().toISOString()
      }
      
      // Record alert
      this.recordAlert(alert)
      
      // Send to all enabled channels
      this.sendToConsole(alert)
      this.sendToFile(alert)
      this.sendToSocket(alert)
      
      return true
    } catch (error) {
      console.error('Error sending alert:', error)
      return false
    }
  }

  // Check if alert should be sent (rate limiting)
  shouldSendAlert(type, severity) {
    const now = Date.now()
    
    // Check cooldown for same alert type
    const lastTime = this.lastAlertTimes.get(type) || 0
    if (now - lastTime < this.config.alertCooldown) {
      return false
    }
    
    // Check hourly limit
    const hourString = new Date().toISOString().slice(0, 13) // YYYY-MM-DDTHH
    const hourlyCount = this.alertCounts.get(hourString) || 0
    if (hourlyCount >= this.config.maxAlertsPerHour) {
      return false
    }
    
    return true
  }

  // Record alert in history
  recordAlert(alert) {
    this.alertHistory.push(alert)
    
    // Update last alert time for this type
    this.lastAlertTimes.set(alert.type, alert.timestamp)
    
    // Update hourly count
    const hourString = new Date(alert.timestamp).toISOString().slice(0, 13)
    this.alertCounts.set(hourString, (this.alertCounts.get(hourString) || 0) + 1)
    
    // Keep only last 1000 alerts
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-1000)
    }
    
    // Log to signals (simplified)
    console.log('Alert generated:', alert.type)
  }

  configureSocket(io) {
    this.io = io
  }

  // Send alert to console
  sendToConsole(alert) {
    if (!this.config.enableConsoleAlerts) return
    
    const colors = {
      info: '\x1b[36m',    // cyan
      warning: '\x1b[33m', // yellow
      critical: '\x1b[31m', // red
      emergency: '\x1b[35m' // magenta
    }
    
    const reset = '\x1b[0m'
    const color = colors[alert.severity] || colors.info
    
    console.log(`${color}[ALERT-${alert.severity.toUpperCase()}]${reset} ${alert.formattedTime} - ${alert.message}`)
    
    if (Object.keys(alert.data).length > 0) {
      console.log('  Data:', JSON.stringify(alert.data, null, 2))
    }
  }

  // Send alert to file (via signals log)
  sendToFile(alert) {
    if (!this.config.enableFileAlerts) return
    
    // Already logged via recordAlert
  }

  // Send alert to socket clients
  sendToSocket(alert) {
    if (!this.config.enableSocketAlerts || !this.socketIO) return
    
    try {
      this.socketIO.emit('alert', alert)
    } catch (error) {
      console.error('Error sending socket alert:', error)
    }
  }

  // Convenience methods for common alert types
  alertDailyLoss(loss, limit, ratio) {
    const severity = ratio >= this.config.dailyLossCriticalThreshold ? 'critical' : 'warning'
    const message = `Daily loss $${loss.toFixed(2)} is ${(ratio * 100).toFixed(1)}% of limit ($${limit.toFixed(2)})`
    
    return this.alert('daily_loss', message, severity, {
      loss,
      limit,
      ratio,
      remaining: limit - loss
    })
  }

  alertConsecutiveLosses(count, maxAllowed) {
    const severity = count >= maxAllowed ? 'critical' : 'warning'
    const message = `${count} consecutive losses detected (limit: ${maxAllowed})`
    
    return this.alert('consecutive_losses', message, severity, {
      count,
      maxAllowed,
      remaining: maxAllowed - count
    })
  }

  alertEmergencyStop(reason, state) {
    const message = `EMERGENCY STOP ACTIVATED: ${reason}`
    
    return this.alert('emergency_stop', message, 'emergency', {
      reason,
      state,
      timestamp: Date.now()
    })
  }

  alertPositionOpened(position) {
    const message = `Position opened: ${position.id.slice(-8)} - Stake: $${position.stake.toFixed(2)}`
    
    return this.alert('position_opened', message, 'info', {
      positionId: position.id,
      stake: position.stake,
      confidence: position.confidence,
      prediction: position.prediction
    })
  }

  alertPositionClosed(position, reason, profit) {
    const severity = profit >= 0 ? 'info' : 'warning'
    const profitText = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`
    const message = `Position closed: ${position.id.slice(-8)} - ${reason} - P&L: ${profitText}`
    
    return this.alert('position_closed', message, severity, {
      positionId: position.id,
      reason,
      profit,
      duration: Date.now() - position.openTime
    })
  }

  alertRiskLevelChange(oldLevel, newLevel, warnings) {
    const severity = newLevel === 'CRITICAL' ? 'critical' : newLevel === 'HIGH' ? 'warning' : 'info'
    const message = `Risk level changed from ${oldLevel} to ${newLevel}`
    
    return this.alert('risk_level_change', message, severity, {
      oldLevel,
      newLevel,
      warnings
    })
  }

  alertSystemError(component, error, context = {}) {
    const message = `System error in ${component}: ${error.message}`
    
    return this.alert('system_error', message, 'critical', {
      component,
      error: {
        message: error.message,
        stack: error.stack
      },
      context
    })
  }

  alertProfitTargetReached(position, profit, target) {
    const message = `Profit target reached for position ${position.id.slice(-8)}: $${profit.toFixed(2)}`
    
    return this.alert('profit_target', message, 'info', {
      positionId: position.id,
      profit,
      target,
      efficiency: target > 0 ? profit / target : 0
    })
  }

  alertLossSignalDetected(position, signals) {
    const signalTypes = signals.map(s => s.type).join(', ')
    const message = `Loss signals detected for position ${position.id.slice(-8)}: ${signalTypes}`
    
    return this.alert('loss_signals', message, 'warning', {
      positionId: position.id,
      signals,
      signalCount: signals.length
    })
  }

  // Generate unique alert ID
  generateAlertId() {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  // Get recent alerts
  getRecentAlerts(limit = 50, severity = null) {
    let alerts = [...this.alertHistory].reverse() // Most recent first
    
    if (severity) {
      alerts = alerts.filter(alert => alert.severity === severity)
    }
    
    return alerts.slice(0, limit)
  }

  // Get alert statistics
  getAlertStats(hours = 24) {
    const since = Date.now() - (hours * 60 * 60 * 1000)
    const recentAlerts = this.alertHistory.filter(alert => alert.timestamp >= since)
    
    const stats = {
      total: recentAlerts.length,
      bySeverity: {},
      byType: {},
      hourly: {}
    }
    
    recentAlerts.forEach(alert => {
      // Count by severity
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1
      
      // Count by type
      stats.byType[alert.type] = (stats.byType[alert.type] || 0) + 1
      
      // Count by hour
      const hour = new Date(alert.timestamp).toISOString().slice(0, 13)
      stats.hourly[hour] = (stats.hourly[hour] || 0) + 1
    })
    
    return stats
  }

  // Clear old alert history
  clearHistory(olderThanHours = 168) { // 1 week default
    const cutoff = Date.now() - (olderThanHours * 60 * 60 * 1000)
    this.alertHistory = this.alertHistory.filter(alert => alert.timestamp >= cutoff)
    
    // Clean old hourly counts
    const cutoffHour = new Date(cutoff).toISOString().slice(0, 13)
    for (const [hour] of this.alertCounts) {
      if (hour < cutoffHour) {
        this.alertCounts.delete(hour)
      }
    }
  }

  // Update configuration
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig }
  }

  // Test alert system
  testAlert() {
    return this.alert('test', 'Alert system is working correctly', 'info', {
      test: true,
      timestamp: Date.now()
    })
  }
}

export default AlertManager
