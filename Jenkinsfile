node ('osx2') {
  stage('Prepare osx workspace') {                    
    // Clean workspace
    deleteDir()

    // Checkout to osx slave
    checkout scm

    // Clone example app
    sh 'git clone git@github.com:jhellar/cordova-showcase-template.git cordova-example'
    dir('cordova-example') {
      sh 'git checkout jenkinsTest2'

      // Restart appium
      sh """
        lsof -i tcp:4723 | grep LISTEN | awk '{print \$2}' | xargs kill
        nohup appium &>"\$HOME/appium.log" </dev/null &
      """
    }
  }

  stage ('Install dependencies') {
    sh '''
      npm install
      npm run bootstrap
      npm run build
    '''
    dir('cordova-example') {
      sh '''
        npm install
        npm link ../packages/core
        npm link ../packages/auth
      '''
      dir('tests') {
        sh '''
          npm install
          npm install mocha-jenkins-reporter
        '''
      }
    }
  }

  def platforms = ['ios', 'android']
  for (int i = 0; i < platforms.size(); i++) {
    platform = platforms[i]                      
    stage("Build ${platform}") {
      try {
        dir('cordova-example') {
          sh """
            npm run ionic:build
            ionic cordova build ${platform} --emulator
          """
        }
      } catch (Exception e) {
        currentBuild.result = 'FAILURE'
      }
    }

    stage ("Run integration test for ${platform}") {
      try {
        dir('cordova-example/tests') {
          sh """
            rm opts.json || true
            cp opts_${platform}.json opts.json
            JUNIT_REPORT_PATH=report.xml JUNIT_REPORT_STACK=1 npm start -- --reporter mocha-jenkins-reporter
            mv report.xml report_${platform}.xml
          """
        }
      } catch (Exception e) {
        currentBuild.result = 'FAILURE'
      }
    }
  }

  stage('Record Results') {
    archive 'cordova-example/tests/report*.xml'
    junit allowEmptyResults: true, testResults: 'cordova-example/tests/report*.xml'
  }
}