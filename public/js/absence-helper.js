function updateAbsenceFormFields() {
    var type = document.getElementById('absenceType').value;
    var fromLabel = document.getElementById('absenceFromLabel');
    var toLabel = document.getElementById('absenceToLabel');
    var fromTime = document.getElementById('absenceFromTime');
    var toTime = document.getElementById('absenceToTime');
    if (!fromLabel || !toLabel) return;
    if (type === 'delay') {
        fromLabel.style.display = 'inline';
        fromLabel.textContent = 'وقت الوصول:';
        toLabel.style.display = 'none';
        toTime.style.display = 'none';
    } else if (type === 'checkout') {
        fromLabel.style.display = 'inline';
        fromLabel.textContent = 'وقت الخروج:';
        toLabel.style.display = 'none';
        toTime.style.display = 'none';
    } else {
        fromLabel.style.display = 'inline';
        fromLabel.textContent = 'من:';
        toLabel.style.display = 'inline';
        toTime.style.display = 'inline';
    }
}
