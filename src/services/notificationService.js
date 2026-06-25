// ============================================
// خدمة الإشعارات اللحظية (SSE)
// ============================================

let peakEventClients = [];

function addClient(res) {
    const clientId = Date.now();
    const newClient = { id: clientId, res: res };
    peakEventClients.push(newClient);
    
    // إرسال رسالة ترحيب
    res.write(`data: ${JSON.stringify({ 
        type: 'connected', 
        message: 'متصل بنظام الإشعارات', 
        timestamp: new Date().toISOString() 
    })}\n\n`);
    
    // إزالة العميل عند انقطاع الاتصال
    res.on('close', () => {
        peakEventClients = peakEventClients.filter(client => client.id !== clientId);
    });
    
    return clientId;
}

function sendNotification(alertData, type = 'new_peak_alert') {
    const eventData = {
        type,
        alert: alertData,
        timestamp: new Date().toISOString(),
        timestampDisplay: new Date().toLocaleString('ar-SA')
    };
    
    peakEventClients.forEach(client => {
        try {
            client.res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        } catch (error) {
            console.error('خطأ في إرسال الإشعار:', error);
        }
    });
}

function getClientsCount() {
    return peakEventClients.length;
}

module.exports = {
    addClient,
    sendNotification,
    getClientsCount
};