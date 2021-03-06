const tf = require('@tensorflow/tfjs')
const utils = require('./src/utils')

// try and load tfjs-node-gpu, but fallback to tfjs-node if no CUDA
require('@tensorflow/tfjs-node-gpu')
if (['webgl', 'cpu'].includes(tf.getBackend())) {
    require('@tensorflow/tfjs-node') 
    console.log('GPU environment not found, loaded @tensorflow/tfjs-node')
} else {
    console.log('loaded @tensorflow/tfjs-node-gpu')
}
console.log(`using tfjs backend "${tf.getBackend()}"`)

const TWEET_SERVER = 'http://localhost:3000'

// if you are on a machine with < 8GB of memory, reduce the batch size to 32
const BATCH_SIZE = 64
const SEQ_LEN = 64
const DROPOUT = 0.1
const VAL_SPLIT = 0.2
const GENERATED_TEXT_LENGTH = 2048
const TOP_N_SAMPLING = 3

// create the Vue.js app, binding to the <div id="app"> element
const app = new Vue({
    el:'#app',
    // Vue automatically updates the HTML DOM when values in data are changed
    // all properties & objects referenced by Vue.js in index.html live here
    data: {
        numEpochs: 2,
        twitter: {
            // twitter user to download data from
            user: 'barackobama',
            // A status message rendered in the UI
            status: 'Click button to download a user\s tweets.'
        },
        data: {
            user: null, // the twitter handle whose data is loaded
            data: null // the user's tweets, encoded and ready for training
        },
        // the currently loaded model
        model: {
            name: null, // either 'base-model' or a twitter handle 
            path: null, // the path to the saved model (e.g. indexeddb://jack)
            model: null, // the loaded model
            training: false, // is the model currently training?
            // status message for model training
            status: 'Select a model to use. Training "base-model" with twitter data will create a new model.'
        },
        // an array of trained model objects containing: { path, name }    
        models: [
        // {
        //     path: 'indexeddb://some-twitter-handle'
        //     name: 'some-twitter-handle'
        // }
        ],
        // an array of tweets that were generated by a trained model.
        // the contents of this array are replaced when new tweets are generated
        generatedTweets: []
    },
    // called by Vue.js once the #app div has been "mounted" and is ready
    mounted: async function (){
        // list the models saved in indexeddb:// and save their names and paths
        // to the app.models array.
        const models = await tf.io.listModels()
        this.models = Object.keys(models).map(path => {
            return {
                path: path,
                name: path.split('//')[1]
            }
        })

        // if this is the first time the app is run, no models will be stored
        // in indexeddb://, so we load the base model from disk and save
        // it to 'indexeddb://base-model' for future reference.
        if (!this.models.map(m => m.name).includes('base-model')) {
            await this.loadModel('./checkpoints/base-model/tfjs/model.json')
            await this.model.model.save('indexeddb://base-model')
            this.models.push({
                name: 'base-model',
                path: 'indexeddb://base-model'
            })
            this.model.path = 'indexeddb://base-model'
        }
    },
    methods: {
        // download and encode a user's tweets and update the UI accordingly.
        // called by clicking the "Download Tweets" button in index.html
        async downloadTweets() {
            this.twitter.status = `Downloading twitter data for ${this.twitter.user}...`
            try {
                const [text, data] = await utils.loadTwitterData(this.twitter.user, TWEET_SERVER)
                this.data.data = data
                this.data.user = this.twitter.user
                this.twitter.status = `Downloaded twitter data for ${this.twitter.user}`
            } catch (err) {
                console.error(err)
                this.twitter.status = `Error downloading twitter data for ${this.twitter.user}`
            }
        },
        // load a model from disk or indexeddb:// and populate data.model.
        // called by clicking the "Load Model" button in index.html
        async loadModel(path) {
            this.model.status = `Loading model from "${path}"...`
            try {
                this.model.model = await tf.loadModel(path)
                this.model.path = path
                this.model.name = path.split('//')[1]
                this.model.status = `Model loaded from "${path}"`
            } catch (err) {
                console.error(err)
                this.model.model = null
                this.model.path = null
                this.model.status = `Error loading model from "${path}"`
            }
        },
        // Fine-tune a model using twitter data
        // called by clicking the "Train Model" button in index.html
        async train() {
            // only train if both model and training data exist
            if (this.model.model && this.data.data) {
                
                const options = {
                    batchSize: BATCH_SIZE,
                    seqLen: SEQ_LEN,
                    dropout: DROPOUT,
                    oneHotLabels: true
                }

                // signify that the training process has begun. This 
                // temporarily disables certain functionality elsewhere in the
                // application
                this.model.training = true
                this.model.status = 'Updating model architecture...'

                this.model.model = utils.updateModelArchitecture(this.model.model, options)
                this.model.model.trainable = true
                this.model.model.compile({ 
                    optimizer: 'adam', 
                    loss: 'categoricalCrossentropy', 
                    metrics: 'categoricalAccuracy' 
                })
                
                this.model.status = 'Training model...'

                const valSplitIndex = Math.floor(this.data.data.length * VAL_SPLIT)
                const valGenerator = utils.batchGenerator(this.data.data.slice(0, valSplitIndex), options)
                const trainGenerator = utils.batchGenerator(this.data.data.slice(valSplitIndex), options)

                try {
                    const callbacks = { 
                        // Render the training and validation loss to the UI
                        // after each epoch
                        onEpochEnd: (epoch, loss, valLoss) => {
                            this.model.status += `<br>Training epoch #${epoch} loss: ${loss.toFixed(2)}, val loss: ${valLoss.toFixed(2)}`
                        } 
                    }
                    
                    // train the model!
                    await utils.fineTuneModel(this.model.model, 
                                              this.numEpochs,
                                              BATCH_SIZE, 
                                              trainGenerator, 
                                              valGenerator,
                                              callbacks)
                } catch (err) {
                    console.error(err)
                    this.model.status = 'Error training model'
                    if (err.message) this.model.status += `: ${err.message}`
                    this.model.training = false
                    return
                }

                // if the model we just trained doesn't share a name with the
                // twitter user, save it as a new model (e.g. base-model trained
                // using @barackobama twitter data will be saved as a new model
                // at indexeddb://barackobama instead of overwriting base-model.)
                if (this.model.name !== this.twitter.user) {
                    const newModel = {
                        name: this.twitter.user,
                        path: `indexeddb://${this.twitter.user}`,
                    }
                    // add the model to the list of available models
                    this.models.push(newModel)
                    // update the model's new name and path
                    this.model.path = newModel.path
                    this.model.name = newModel.name
                }

                // save the model so we can load it again later
                this.model.status += `<br>Saving trained model to ${this.model.path}`
                await this.model.model.save(this.model.path)
                this.model.status += `<br>Model saved. Done.`

                // training is now done
                this.model.training = false
            }
        },
        // Generate text using the model
        // called by clicking the "Generate Tweets" button in index.html
        async generate() {
            // only generate tweets if a model has been loaded
            if (this.model.model) {
                this.model.status = 'Updating model architecture...'
                let inferenceModel = utils.updateModelArchitecture(this.model.model)
                inferenceModel.trainable = false
                
                const seed = "This is a seed sentence."
                this.model.status = `Generating text using ${this.model.path}`
                const generated = await utils.generateText(inferenceModel, 
                                                           seed, 
                                                           GENERATED_TEXT_LENGTH, 
                                                           TOP_N_SAMPLING)

                // separate tweets using the newline character
                const tweets = generated.split('\n')

                // remove the first and last tweets, as they usually are garbage
                if (tweets.length > 2) {
                    tweets.shift()
                    tweets.pop()    
                }

                // assign the tweets to the generateTweets variable so that
                // Vue.js can render them to the UI
                this.generatedTweets = tweets
                this.model.status = `Finished generating text using ${this.model.path}`
            }
        }
    }
})
