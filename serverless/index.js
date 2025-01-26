const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const exec = promisify(require('child_process').exec);
// const DynamoDB = require('aws-sdk/clients/dynamodb');
const awsSDK = require('aws-sdk');
// const dynamoDB = new DynamoDB();
let docClient = new awsSDK.DynamoDB.DocumentClient();
console.log("outside handler");
const sendEmail = async (apiKey, domain, userEmail, fileSize, dynamoDBTableName, submissionUrl,errorMessage=null,successPath=null) => {
    const emailSubject = 'Submission Status';
    let downloadStatuss=''
    let emailText;
    if (errorMessage) {
        emailText = `Hey,\n\nWe encountered an issue while processing your submission:\n\n${errorMessage}\n\nBest regards,\nVidya`;
        downloadStatuss = 'No Content';
    } 
    else if (fileSize === '0') {
        emailText = `Hey,\n\nYour submission was empty and not processed.\n\nBest regards,\nVidya`;
        downloadStatuss = 'No content';
    } 
    else {
        emailText = `Hey,\n\nYour submission was ${fileSize} bytes and successfully uploaded to Google Cloud Storage.\n\n GCP file path: ${successPath} \n\nThank you for your submission.\n\nBest regards,\nVidya`;
        downloadStatuss = 'Success';
    }

     if(downloadStatuss==='success')
     {
        successPath=successPath
     }
     else{
        successPath='N/A'
     }
    
    // const emailSubject = 'Submission Status';
    // const emailText = `Dear ${userEmail},\n\nYour submission was ${fileSize} bytes and ${
    //     fileSize === '0' ? 'not ' : ''
    // }successfully uploaded to Google Cloud Storage.`;
    const emailData = {
        from: 'noreply@learnright.me',
        to: userEmail,
        subject: emailSubject,
        text: emailText,
    };
    const mailgunBaseUrl = "https://api.mailgun.net/v3";
const mailgunApiUrl = `${mailgunBaseUrl}/${domain}/messages`;
    // const mailgunApiUrl = `https://api.mailgun.net/v3/${domain}/messages`;
    try {
        await axios.post(mailgunApiUrl, null, {
            auth: {
                username: 'api',
                password: apiKey,
            },
            params: emailData,
        });
        console.log('Email sent successfully');
        const dynamoDBParams = {
            TableName: dynamoDBTableName,
            Item: {
                id: uuidv4(), // Generate a unique UUID
                userEmail: { S: userEmail },
                submissionUrl: { S: submissionUrl },
                downloadStatus: { S: downloadStatuss },
                emailSent:{S: 'Yes'},
                successPath:{S: successPath},
                Timestamp: { N: `${Date.now()}` },
            },
        };
        await docClient.put(dynamoDBParams).promise();
    } catch (error) {
        if (error.response) {
            console.error('Error sending email. Server responded with:', error.response.status, error.response.data);
        } else if (error.request) {
            console.error('Error sending email. No response received.');
        } else {
            console.error('Error setting up the email request:', error.message);
        }
        const dynamoDBParams = {
            TableName: dynamoDBTableName,
            Item: {
                id: uuidv4(),  // Generate a unique UUID
                userEmail: { S: userEmail },
                submissionUrl: { S: submissionUrl },
                downloadStatus: { S: downloadStatuss },
                emailSent:{S: 'No'},
                successPath:{S: successPath},
                Timestamp: { N: `${Date.now()}` },
            },
        };
        await docClient.put(dynamoDBParams).promise();
        throw error;
    }
};
const handler = async (event, context) => {
    try {
        console.log(event);
        const snsMessage = JSON.parse(event.Records[0].Sns.Message);
        const submissionUrl = snsMessage.submission_url;
        const userEmail = snsMessage.email;
        const dynamoDBTableName = process.env.DYNAMODB_TABLE_NAME;
        console.log(snsMessage)
        console.log(submissionUrl)
        console.log(userEmail)
        const encodedPrivateKey = process.env.GOOGLE_PRIVATE_KEY;
        const decodedPrivateKey = Buffer.from(encodedPrivateKey, 'base64').toString('utf-8');
        const mailgunApiKey = process.env.MAILGUN_API_KEY;
        const mailgunDomain = process.env.MAILGUN_DOMAIN;
        const keyFilePath = '/tmp/google-access-key.json';
        fs.writeFileSync(keyFilePath, decodedPrivateKey);
        const googleAccessKey = keyFilePath;
        const bucketName = process.env.BUCKET_NAME;
         
        
        const downloadCommand = submissionUrl;
        try {
            // Check if the URL ends with ".zip"
            if (!submissionUrl.toLowerCase().endsWith('.zip')) {
                const errorMessage = 'Invalid file format. Only ZIP files are supported.';
                console.error(errorMessage);
                await sendEmail(mailgunApiKey, mailgunDomain, userEmail, null, dynamoDBTableName, submissionUrl, errorMessage, null);
                throw new Error(errorMessage);
            }
            const response = await axios.get(downloadCommand, { responseType: 'stream' });
           
            const filePath = path.join('/tmp', 'main.zip');
            const fileStream = fs.createWriteStream(filePath);
            response.data.pipe(fileStream);
            await new Promise((resolve, reject) => {
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });
            const { stdout } = await exec(`wc -c ${filePath}`);
            const fileSize = stdout.trim().split(' ')[0];
            if (fileSize === '0') {
                throw new Error('Downloaded file is empty.');
            }
            const storage = new Storage({ keyFilename: googleAccessKey });
            const bucket = storage.bucket(bucketName);
            const uploadOptions = {
                destination: `submissions/${userEmail}_${Date.now()}_submission.zip`,
            };
            await bucket.upload(filePath, uploadOptions);
            const successPath = `gs://${bucketName}/submissions/${userEmail}_${Date.now()}_submission.zip`;
        //      // List the files in the bucket
        // const [files] = await bucket.getFiles();
        // // Find the file object corresponding to the uploaded file
        // const uploadedFile = files.find(file => file.name === successPath);
        // // Generate the URL based on the bucket's default URL structure
        // const fileUrl = `https://storage.googleapis.com/${bucketName}/${uploadedFile.name}`;
            await fs.promises.unlink(filePath);
            try {
                await fs.promises.unlink(keyFilePath);
                console.log(`Key file (${keyFilePath}) removed successfully.`);
            } catch (unlinkError) {
                console.warn(`Error removing key file (${keyFilePath}):`, unlinkError.message);
            }
            
            await sendEmail(mailgunApiKey, mailgunDomain, userEmail, fileSize, dynamoDBTableName, submissionUrl,null,successPath);
            console.log(`Submission from ${userEmail} successfully downloaded (${fileSize} bytes) and uploaded to GCS`);
            return 'Success';
        } catch (error) {
            if (error.response && error.response.status === 404) {
                const errorMessage = `The URL does not exist.`;
                console.error(errorMessage);
                await sendEmail(mailgunApiKey, mailgunDomain, userEmail, null, dynamoDBTableName, submissionUrl, errorMessage,null);
            } else {
                console.error('Error:', error);
                throw error;
            }
            // console.error('Error during submission:', error);
 
            // await sendEmail(mailgunApiKey, mailgunDomain, userEmail, null, dynamoDBTableName, submissionUrl, error.message);
            // throw error;
        }
    } catch (error) {
        console.error('Error:', error);
        throw error;
    }
};
module.exports = { handler };