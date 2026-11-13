// js/teacher-utils.js
let currentSubjectType = 'Core Subjects';

const SUBJECT_WEIGHTS = {            
  'Academic Electives':                         [0.20, 0.50, 0.30],
  'Arts Apprenticeship':                        [0.15, 0.70, 0.15],
  'Arts, Sports, Health and Wellness Electives':[0.20, 0.60, 0.20],
  'Core Subjects':                              [0.20, 0.50, 0.30],
  'Creative Production and Innovation':         [0.15, 0.70, 0.15],
  'Design and Innovation':                      [0.40, 0.60, 0],
  'Field Exposure':                             [0.15, 0.70, 0.15],
  'Research Electives':                         [0.40, 0.60, 0],
  'TechPro Electives':                          [0.15, 0.65, 0.20],
  'Work Immersion':                             [0.20, 0.80, 0]
};

const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];

function transmute(initial) {
  for (const [min, grade] of TRANSMUTATION) if (initial > min) return grade;
  return 0;
}

function getDescriptor(term) {
  if (term > 89) return 'Advancing';
  if (term > 79) return 'Benchmarking';
  if (term > 74) return 'Connecting';
  if (term > 64) return 'Developing';
  if (term > 0)  return 'Emerging';
  return '';
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// --- ATTENDANCE MATH ---
const LATES_PER_ABSENCE = 3;
const EXCUSED_COUNTS_AS_ABSENT = false;

function computeAttendance({ present = 0, late = 0, excused = 0, absent = 0 } = {}) {
  present = +present || 0; late = +late || 0; excused = +excused || 0; absent = +absent || 0;
  const converted = Math.floor(late / LATES_PER_ABSENCE);          
  return {
    present: present + late - converted,                           
    absent: absent + converted + (EXCUSED_COUNTS_AS_ABSENT ? excused : 0),
    late, excused, converted
  };
}