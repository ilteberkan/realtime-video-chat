// Redis olmadan basit kuyruk simülasyonu
const queues = {};

const createQueue = (name) => {
  if (!queues[name]) {
    queues[name] = {
      name,
      jobs: [],
      processors: {},
      
      add: function(jobName, data, options = {}) {
        const job = { id: Date.now(), name: jobName, data, options };
        this.jobs.push(job);
        
        // Hemen işle veya geciktir
        if (options.delay) {
          setTimeout(() => this.processJob(job), options.delay);
        } else {
          this.processJob(job);
        }
        
        return Promise.resolve(job);
      },
      
      process: function(jobName, processor) {
        this.processors[jobName] = processor;
        return this;
      },
      
      processJob: function(job) {
        const processor = this.processors[job.name];
        if (processor) {
          processor(job)
            .then(result => {
              console.log(`${name} kuyruğunda iş tamamlandı: ${job.id}`, result);
            })
            .catch(err => {
              console.error(`${name} kuyruğunda iş başarısız oldu: ${job.id}`, err);
            });
        }
      },
      
      on: function(event, callback) {
        // Olay dinleyicileri için basit bir stub
        return this;
      }
    };
  }
  
  return queues[name];
};

module.exports = { createQueue }; 